import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, cpSync } from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { PROMPTS } from './agents.js';
import { getLog, getBranches, commitAll, pushRepo, getFiles, getFileTree } from './git.js';
import { listProjects, createProject, getProject, cloneRepo, deleteProject, PROJECTS_DIR } from './projects.js';
import { WsMessage } from './types.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const runningBuilds: Record<string, ChildProcess> = {};
const terminals: Record<string, ReturnType<typeof pty.spawn>> = {};
let terminalSeq = 0;

function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

// Убиваем всю группу процессов (npm → node/vite и т.п.), а не только bash-обёртку
function killBuild(proc: ChildProcess): void {
  try {
    if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
    else proc.kill();
  } catch {
    try { proc.kill(); } catch { /* ignore */ }
  }
}

// Подбираем команду запуска из package.json открытого проекта и привязываем её к нужному порту.
// Приоритет скриптов: start → dev → preview. Если скриптов нет — отдаём папку статикой.
function buildRunCommand(projectPath: string, port: number): string {
  const pkgPath = path.join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const scripts: Record<string, string> = pkg.scripts || {};
      const name = ['start', 'dev', 'preview'].find(n => scripts[n]);
      if (name) {
        const hasDeps = pkg.dependencies || pkg.devDependencies;
        const needInstall = hasDeps && !existsSync(path.join(projectPath, 'node_modules'));
        const install = needInstall ? 'npm install && ' : '';
        // Vite не читает PORT из env — порт/хост передаём флагами
        const isVite = /vite/.test(scripts[name]);
        if (isVite) return `${install}npm run ${name} -- --host 0.0.0.0 --port ${port}`;
        return `${install}npm run ${name}`;
      }
    } catch { /* битый package.json — упадём в статику */ }
  }
  return `python3 -m http.server ${port} --bind 0.0.0.0`;
}

// Общий менеджер запускается с cwd = PROJECTS_DIR. Чтобы claude CLI подхватил навыки,
// копируем их из репозитория (backend/skills) в PROJECTS_DIR/.claude/skills при старте.
function syncManagerSkills(): void {
  try {
    const src = path.resolve('skills');
    if (!existsSync(src)) return;
    const dest = path.join(PROJECTS_DIR, '.claude', 'skills');
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
  } catch (e) { console.error('skill sync failed:', e); }
}

app.get('/api/projects', (_req, res) => res.json(listProjects()));
app.post('/api/projects', async (req, res) => { const proj = await createProject(req.body.name); res.json(proj); });
app.post('/api/projects/clone', async (req, res) => {
  try {
    const proj = await cloneRepo(req.body.url, req.body.name);
    broadcast({ type: 'projects_updated' });
    res.json(proj);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/projects/:id', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (runningBuilds[p.id]) { killBuild(runningBuilds[p.id]); delete runningBuilds[p.id]; }
  try {
    deleteProject(p.id);
    broadcast({ type: 'projects_updated' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/projects/:id/log', async (req, res) => { const p = getProject(req.params.id); if (!p) return res.json([]); res.json(await getLog(p.path)); });
app.get('/api/projects/:id/branches', async (req, res) => { const p = getProject(req.params.id); if (!p) return res.json({ all: [], current: '' }); res.json(await getBranches(p.path)); });
app.get('/api/projects/:id/files', (req, res) => { const p = getProject(req.params.id); if (!p) return res.json([]); res.json(getFiles(p.path)); });
app.get('/api/projects/:id/tree', (req, res) => { const p = getProject(req.params.id); if (!p) return res.json([]); res.json(getFileTree(p.path)); });

app.get('/api/projects/:id/file/*', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const filename = (req.params as Record<string, string>)[0];
    const content = readFileSync(path.join(p.path, filename), 'utf-8');
    res.json({ content });
  } catch { res.status(404).json({ error: 'File not found' }); }
});

app.post('/api/projects/:id/file/*', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const filename = (req.params as Record<string, string>)[0];
    writeFileSync(path.join(p.path, filename), req.body.content, 'utf-8');
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Write failed' }); }
});

// FS operations: create file
app.post('/api/projects/:id/fs/file', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const filePath = path.join(p.path, req.body.path);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, req.body.content || '', 'utf-8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// FS operations: create dir
app.post('/api/projects/:id/fs/dir', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    mkdirSync(path.join(p.path, req.body.path), { recursive: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// FS operations: delete
app.delete('/api/projects/:id/fs/*', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const fsPath = path.join(p.path, (req.params as Record<string, string>)[0]);
    if (existsSync(fsPath)) rmSync(fsPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});


// FS: rename
app.post('/api/projects/:id/fs/rename', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const oldPath = path.join(p.path, req.body.oldPath);
    const newPath = path.join(p.path, req.body.newPath);
    renameSync(oldPath, newPath);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/projects/:id/commit', async (req, res) => { const p = getProject(req.params.id); if (!p) return res.json({ ok: false }); await commitAll(p.path, req.body.message || 'chore: update'); res.json({ ok: true }); });
app.post('/api/projects/:id/push', async (req, res) => { const p = getProject(req.params.id); if (!p) return res.json({ ok: false }); await pushRepo(p.path); res.json({ ok: true }); });

app.post('/api/projects/:id/build/start', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.json({ ok: false });
  const port: number = req.body.port || 8080;
  if (runningBuilds[p.id]) killBuild(runningBuilds[p.id]);
  const cmd = buildRunCommand(p.path, port);
  // detached: true — процесс становится лидером группы, чтобы потом убить всё дерево
  const proc = spawn('bash', ['-lc', cmd], {
    cwd: p.path,
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0' },
    detached: true,
  });
  runningBuilds[p.id] = proc;
  proc.stdout?.on('data', d => broadcast({ type: 'build_log', project: p.id, text: d.toString() }));
  proc.stderr?.on('data', d => broadcast({ type: 'build_log', project: p.id, text: d.toString() }));
  proc.on('exit', () => { broadcast({ type: 'build_status', project: p.id, running: false }); delete runningBuilds[p.id]; });
  broadcast({ type: 'build_status', project: p.id, running: true, port });
  res.json({ ok: true, port, cmd });
});

app.post('/api/projects/:id/build/stop', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.json({ ok: false });
  if (runningBuilds[p.id]) { killBuild(runningBuilds[p.id]); delete runningBuilds[p.id]; }
  res.json({ ok: true });
});

wss.on('connection', ws => {
  let terminalId: string | null = null;

  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsMessage;

      // Создание терминала. Если задан agent — в PTY запускается интерактивный claude
      // с ролевым системным промптом (виден весь процесс; скиллы берутся из cwd/.claude/skills),
      // иначе обычный bash. Общий менеджер (overseer) работает в корне всех проектов.
      if (msg.type === 'terminal_create') {
        const agent = msg.agent;
        let cwd: string;
        if (agent === 'overseer') {
          cwd = PROJECTS_DIR;
        } else {
          const p = msg.projectId ? getProject(msg.projectId) : undefined;
          if (!p) return;
          cwd = p.path;
        }
        const id = (msg.projectId || agent || 'term') + '_' + Date.now() + '_' + (++terminalSeq);
        terminalId = id;

        let cmd = 'bash';
        let args: string[] = [];
        if (agent) {
          const sys = (PROMPTS[agent] || PROMPTS.manager).replace(/{p}/g, cwd);
          cmd = 'claude';
          args = ['--append-system-prompt', sys, '--dangerously-skip-permissions'];
        }

        const term = pty.spawn(cmd, args, {
          name: 'xterm-256color',
          cols: msg.cols || 120,
          rows: msg.rows || 30,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
        terminals[id] = term;
        term.onData(data => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_data', data, terminalId: id }));
        });
        term.onExit(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_exit', terminalId: id }));
          delete terminals[id];
          // агент мог склонировать репозиторий / изменить файлы — обновим список проектов
          if (agent) broadcast({ type: 'projects_updated' });
        });
        ws.send(JSON.stringify({ type: 'terminal_ready', terminalId: id }));
        return;
      }

      if (msg.type === 'terminal_input' && msg.terminalId && terminals[msg.terminalId]) {
        terminals[msg.terminalId].write(msg.data || '');
        return;
      }

      if (msg.type === 'terminal_resize' && msg.terminalId && terminals[msg.terminalId]) {
        terminals[msg.terminalId].resize(msg.cols || 120, msg.rows || 30);
        return;
      }

      // Tree refresh request from terminal
      if (msg.type === 'tree_refresh' && msg.projectId) {
        const p = getProject(msg.projectId);
        if (p) broadcast({ type: 'tree_updated', projectId: msg.projectId, tree: getFileTree(p.path) });
        return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', text: String(e) }));
    }
  });

  ws.on('close', () => {
    if (terminalId && terminals[terminalId]) {
      terminals[terminalId].kill();
      delete terminals[terminalId];
    }
  });
});

const SERVER_PORT = Number(process.env.PORT || 3001);
syncManagerSkills();
server.listen(SERVER_PORT, '0.0.0.0', () => console.log('Backend running on :' + SERVER_PORT));
