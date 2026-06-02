import { spawn, ChildProcess } from 'child_process';
import { watch, FSWatcher } from 'fs';

const PROMPTS: Record<string, string> = {
  manager: 'Ты менеджер проекта. Декомпозируй задачи и координируй команду. Директория: {p}.',
  coder: 'Ты программист. Пишешь код, создаёшь файлы, делаешь git commits. Директория: {p}.',
  reviewer: 'Ты ревьюер кода. Анализируй качество и безопасность. Директория: {p}.'
};

interface HistoryItem { role: string; content: string; }
// История диалога индексируется по sessionId — у каждой открытой сессии своя.
const hist: Record<string, HistoryItem[]> = {};

export async function chat(
  sessionId: string,
  agentType: string,
  message: string,
  projectPath: string,
  onChunk: (text: string) => void,
  onStatus: (status: string) => void,
  onFileChanged: (filename: string) => void,
  onSpawn?: (proc: ChildProcess) => void
): Promise<string> {
  const key = sessionId;
  if (!hist[key]) hist[key] = [];
  const sys = (PROMPTS[agentType] || PROMPTS.manager).replace(/{p}/g, projectPath);
  hist[key].push({ role: 'user', content: message });
  const txt = hist[key].map(m => (m.role === 'user' ? 'Human' : 'Assistant') + ': ' + m.content).join('\n\n');
  const prompt = sys + '\n\n' + txt;

  return new Promise((resolve, reject) => {
    onStatus('thinking');

    let watcher: FSWatcher | null = null;
    const changedFiles = new Set<string>();
    const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

    try {
      watcher = watch(projectPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (name.startsWith('.git') || name.includes('node_modules')) return;
        clearTimeout(debounceTimers[name]);
        debounceTimers[name] = setTimeout(() => {
          if (!changedFiles.has(name)) {
            changedFiles.add(name);
            onFileChanged(name);
          }
        }, 300);
      });
    } catch { /* ignore */ }

    const p = spawn('claude', ['--print', '--dangerously-skip-permissions', prompt], {
      cwd: projectPath,
      env: { ...process.env }
    });
    onSpawn?.(p);

    let full = '';
    let buf = '';
    let started = false;

    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!started && line.trim()) { started = true; onStatus('responding'); }
        onChunk(line + '\n');
        full += line + '\n';
      }
    });

    p.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      if (text.includes('Thinking') || text.includes('thinking')) onStatus('thinking');
      else if (text.includes('tool') || text.includes('Tool')) onStatus('using_tool');
      else if (text.includes('Reading') || text.includes('Writing') || text.includes('Creating')) onStatus('file_operation');
      else if (text.trim()) onStatus('working');
    });

    p.on('close', () => {
      if (watcher) watcher.close();
      if (buf.trim()) { onChunk(buf); full += buf; }
      onStatus('done');
      // hist[key] мог быть удалён через clearSession (закрытие сессии) пока процесс завершался
      if (hist[key]) hist[key].push({ role: 'assistant', content: full });
      resolve(full);
    });

    p.on('error', (err: Error) => {
      if (watcher) watcher.close();
      onStatus('error');
      reject(err);
    });
  });
}

export function clearSession(sessionId: string): void {
  delete hist[sessionId];
}
