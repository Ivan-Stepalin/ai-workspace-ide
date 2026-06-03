import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import cors from 'cors';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, cpSync } from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { PROMPTS } from './agents.js';
import { getLog, getBranches, commitAll, pushRepo, getFiles, getFileTree, invalidateGitCache } from './git.js';
import { listProjects, createProject, getProject, cloneRepo, deleteProject, PROJECTS_DIR } from './projects.js';
import { initTelegramBot } from './telegram.js';
import { WsMessage } from './types.js';

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

const FRONTEND_DIST = process.env.FRONTEND_DIST || path.resolve('../frontend/dist');
const serveFrontend = existsSync(FRONTEND_DIST);
if (serveFrontend) {
  const ASSETS_SEG = path.sep + 'assets' + path.sep;
  app.use(express.static(FRONTEND_DIST, {
    index: false,
    setHeaders: (res, p) => {
      if (p.endsWith('index.html') || p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      else if (p.includes(ASSETS_SEG)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
}

const server = createServer(app);
const wss = new WebSocketServer({ server });

const DETACH_GC_MS = 30 * 60 * 1000;
const BUF_CAP = 256 * 1024;
const FLUSH_MS = 16; // batch terminal output ~60fps

interface Term {
  pty: ReturnType<typeof pty.spawn>;
  // Кольцевой буфер: массив чанков + суммарная длина; соединяется только при переподключении.
  bufferChunks: string[];
  bufferLen: number;
  // Батчинг WS-сообщений: накапливаем данные между тиками таймера.
  pendingData: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  ws: WebSocket | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  agent?: string;
  workspaceId: string;
  seq: number;
}
const terminals: Record<string, Term> = {};
let termSeq = 0;

// Подписки: главный WS каждого воркспейса регистрируется для получения broadcast-событий.
const wsSubscriptions = new Map<WebSocket, string>();

function killTerminal(id: string): void {
  const t = terminals[id];
  if (!t) return;
  if (t.killTimer) clearTimeout(t.killTimer);
  if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null; }
  try { t.pty.kill(); } catch { /* ignore */ }
  delete terminals[id];
}

// Глобальный broadcast (projects_updated и т.п. — нужен всем вкладкам).
function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

// Broadcast только подписчикам конкретного воркспейса (tree_updated, file_changed).
function broadcastToWorkspace(workspaceId: string, data: object): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && wsSubscriptions.get(c) === workspaceId) c.send(msg);
  });
}

function syncManagerSkills(): void {
  try {
    const src = path.resolve('skills');
    if (!existsSync(src)) return;
    const dest = path.join(PROJECTS_DIR, '.claude', 'skills');
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
  } catch (e) { console.error('skill sync failed:', e); }
}

function syncProjectsGuide(): void {
  try {
    const src = path.resolve('PROJECTS_CLAUDE.md');
    if (!existsSync(src)) return;
    mkdirSync(PROJECTS_DIR, { recursive: true });
    cpSync(src, path.join(PROJECTS_DIR, 'CLAUDE.md'));
  } catch (e) { console.error('projects guide sync failed:', e); }
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
    invalidateGitCache(p.path);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Write failed' }); }
});

app.post('/api/projects/:id/fs/file', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const filePath = path.join(p.path, req.body.path);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, req.body.content || '', 'utf-8');
    invalidateGitCache(p.path);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/projects/:id/fs/dir', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    mkdirSync(path.join(p.path, req.body.path), { recursive: true });
    invalidateGitCache(p.path);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/projects/:id/fs/*', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const fsPath = path.join(p.path, (req.params as Record<string, string>)[0]);
    if (existsSync(fsPath)) rmSync(fsPath, { recursive: true, force: true });
    invalidateGitCache(p.path);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/projects/:id/fs/rename', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try {
    const oldPath = path.join(p.path, req.body.oldPath);
    const newPath = path.join(p.path, req.body.newPath);
    renameSync(oldPath, newPath);
    invalidateGitCache(p.path);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/projects/:id/commit', async (req, res) => { const p = getProject(req.params.id); if (!p) return res.json({ ok: false }); await commitAll(p.path, req.body.message || 'chore: update'); res.json({ ok: true }); });
app.post('/api/projects/:id/push', async (req, res) => { const p = getProject(req.params.id); if (!p) return res.json({ ok: false }); await pushRepo(p.path); res.json({ ok: true }); });

app.get('/api/workspaces/:wid/terminals', (req, res) => {
  const wid = req.params.wid;
  const list = Object.entries(terminals)
    .filter(([, t]) => t.workspaceId === wid)
    .sort((a, b) => a[1].seq - b[1].seq)
    .map(([id, t]) => ({ id, agent: t.agent ?? null }));
  res.json(list);
});

if (serveFrontend) {
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

wss.on('connection', ws => {
  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsMessage;

      // Подписка главного WS воркспейса — для получения scoped-бродкастов (tree_updated и т.п.).
      if (msg.type === 'subscribe' && msg.workspaceId) {
        wsSubscriptions.set(ws, msg.workspaceId);
        return;
      }

      if (msg.type === 'terminal_create') {
        const agent = msg.agent;
        let cwd: string;
        if (agent === 'overseer' || msg.projectId === 'overseer') {
          cwd = PROJECTS_DIR;
        } else {
          const p = msg.projectId ? getProject(msg.projectId) : undefined;
          if (!p) return;
          cwd = p.path;
        }
        const id = msg.terminalId || ('term_' + Date.now() + '_' + Math.random().toString(36).slice(2));

        // Переподключение: гасим GC, перевязываем ws, сбрасываем накопленный буфер одним сообщением.
        const existing = terminals[id];
        if (existing) {
          if (existing.killTimer) { clearTimeout(existing.killTimer); existing.killTimer = null; }
          existing.ws = ws;
          try { existing.pty.resize(msg.cols || 120, msg.rows || 30); } catch { /* ignore */ }
          ws.send(JSON.stringify({ type: 'terminal_ready', terminalId: id }));
          if (existing.bufferLen > 0) {
            ws.send(JSON.stringify({ type: 'terminal_data', data: existing.bufferChunks.join(''), terminalId: id }));
          }
          return;
        }

        let cmd = 'bash';
        let args: string[] = [];
        if (agent) {
          const sys = (PROMPTS[agent] || PROMPTS.manager).replace(/{p}/g, cwd);
          cmd = 'claude';
          args = ['--append-system-prompt', sys, '--dangerously-skip-permissions'];
        }

        const proc = pty.spawn(cmd, args, {
          name: 'xterm-256color',
          cols: msg.cols || 120,
          rows: msg.rows || 30,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
        const workspaceId = agent === 'overseer' ? 'overseer' : (msg.projectId || '');
        const t: Term = {
          pty: proc,
          bufferChunks: [], bufferLen: 0,
          pendingData: '', flushTimer: null,
          ws, killTimer: null,
          agent, workspaceId, seq: ++termSeq,
        };
        terminals[id] = t;

        proc.onData(data => {
          // Кольцевой буфер: O(1) запись, O(n) чтение при переподключении (редко).
          t.bufferChunks.push(data);
          t.bufferLen += data.length;
          while (t.bufferLen > BUF_CAP && t.bufferChunks.length > 0) {
            t.bufferLen -= t.bufferChunks[0].length;
            t.bufferChunks.shift();
          }
          if (!t.ws || t.ws.readyState !== WebSocket.OPEN) return;
          t.pendingData += data;
          if (t.flushTimer === null) {
            t.flushTimer = setTimeout(() => {
              t.flushTimer = null;
              if (t.ws && t.ws.readyState === WebSocket.OPEN && t.pendingData) {
                t.ws.send(JSON.stringify({ type: 'terminal_data', data: t.pendingData, terminalId: id }));
              }
              t.pendingData = '';
            }, FLUSH_MS);
          }
        });

        proc.onExit(() => {
          // Сбрасываем незаотправленные данные перед сигналом о завершении.
          if (t.flushTimer) { clearTimeout(t.flushTimer); t.flushTimer = null; }
          if (t.ws && t.ws.readyState === WebSocket.OPEN) {
            if (t.pendingData) t.ws.send(JSON.stringify({ type: 'terminal_data', data: t.pendingData, terminalId: id }));
            t.ws.send(JSON.stringify({ type: 'terminal_exit', terminalId: id }));
          }
          t.pendingData = '';
          if (t.killTimer) clearTimeout(t.killTimer);
          delete terminals[id];
          if (agent) broadcast({ type: 'projects_updated' });
        });

        ws.send(JSON.stringify({ type: 'terminal_ready', terminalId: id }));
        return;
      }

      if (msg.type === 'terminal_input' && msg.terminalId && terminals[msg.terminalId]) {
        terminals[msg.terminalId].pty.write(msg.data || '');
        return;
      }

      if (msg.type === 'terminal_resize' && msg.terminalId && terminals[msg.terminalId]) {
        terminals[msg.terminalId].pty.resize(msg.cols || 120, msg.rows || 30);
        return;
      }

      if (msg.type === 'terminal_close' && msg.terminalId) {
        killTerminal(msg.terminalId);
        return;
      }

      if (msg.type === 'tree_refresh' && msg.projectId) {
        const p = getProject(msg.projectId);
        if (p) {
          invalidateGitCache(p.path);
          broadcastToWorkspace(msg.projectId, { type: 'tree_updated', projectId: msg.projectId, tree: getFileTree(p.path) });
        }
        return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', text: String(e) }));
    }
  });

  ws.on('close', () => {
    wsSubscriptions.delete(ws);
    for (const id in terminals) {
      const t = terminals[id];
      if (t.ws === ws) {
        t.ws = null;
        if (t.killTimer) clearTimeout(t.killTimer);
        t.killTimer = setTimeout(() => killTerminal(id), DETACH_GC_MS);
      }
    }
  });
});

const SERVER_PORT = Number(process.env.PORT || 3001);
syncManagerSkills();
syncProjectsGuide();
initTelegramBot();
server.listen(SERVER_PORT, '0.0.0.0', () => console.log('Backend running on :' + SERVER_PORT));
