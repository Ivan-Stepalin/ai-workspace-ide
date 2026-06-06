// Нативный чат с агентом в браузере: headless `claude` (см. agent-stream.ts), события
// которого нормализуются и шлются в браузер по WebSocket как chat_event. Контекст диалога
// держится через --resume (session_id из события init). Источник истины — сервер: живые
// сессии лежат в памяти (Map), поэтому переподключение из свежей вкладки восстанавливает
// диалог через chat_restore (как у терминалов). session_id персистится в workspace.db,
// чтобы --resume пережил перезапуск бэкенда.
import { WebSocket } from 'ws';
import { ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { getProject, PROJECTS_DIR, DB_PATH } from './projects.js';
import { runClaude } from './agent-stream.js';
import { WsMessage } from './types.js';

const DETACH_GC_MS = 30 * 60 * 1000;

export interface ChatMsg { role: 'user' | 'assistant' | 'tool'; text: string; name?: string }
interface ChatSession {
  workspaceId: string;          // projectId или 'overseer'
  agent: string;
  cwd: string;
  sessionId: string | null;     // для --resume
  history: ChatMsg[];
  proc: ChildProcess | null;    // активный ответ (один на чат)
  ws: WebSocket | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const chats = new Map<string, ChatSession>();
let db: Database.Database | null = null;

export function initChatDb(): void {
  db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
    chat_id TEXT PRIMARY KEY,
    workspace_id TEXT,
    agent TEXT,
    session_id TEXT,
    updated_at INTEGER
  )`);
}

function persist(chatId: string, s: ChatSession): void {
  if (!db) return;
  db.prepare(`INSERT INTO chat_sessions (chat_id, workspace_id, agent, session_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id, agent=excluded.agent,
      session_id=excluded.session_id, updated_at=excluded.updated_at`)
    .run(chatId, s.workspaceId, s.agent, s.sessionId, Date.now());
}

function send(s: ChatSession, data: object): void {
  if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(data));
}

// Список живых чат-сессий воркспейса — для переподключения фронта (аналог /terminals).
export function listChats(workspaceId: string): { id: string; agent: string }[] {
  return [...chats.entries()]
    .filter(([, s]) => s.workspaceId === workspaceId)
    .map(([id, s]) => ({ id, agent: s.agent }));
}

// Возвращает true, если сообщение относится к чату и обработано.
export function handleChatWs(ws: WebSocket, msg: WsMessage): boolean {
  const chatId = msg.chatId;

  if (msg.type === 'chat_create' && chatId) {
    const agent = msg.agent || 'manager';
    const workspaceId = agent === 'overseer' || msg.projectId === 'overseer' ? 'overseer' : (msg.projectId || '');
    let cwd: string;
    if (workspaceId === 'overseer') {
      cwd = PROJECTS_DIR;
    } else {
      const p = getProject(workspaceId);
      if (!p) { ws.send(JSON.stringify({ type: 'chat_event', chatId, event: { kind: 'error', text: 'Проект не найден' } })); return true; }
      cwd = p.path;
    }

    let s = chats.get(chatId);
    if (s) {
      // переподключение: гасим GC, перевязываем ws, отдаём историю
      if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
      s.ws = ws;
    } else {
      s = { workspaceId, agent, cwd, sessionId: null, history: [], proc: null, ws, killTimer: null };
      chats.set(chatId, s);
    }
    ws.send(JSON.stringify({ type: 'chat_ready', chatId }));
    if (s.history.length) ws.send(JSON.stringify({ type: 'chat_restore', chatId, messages: s.history }));
    return true;
  }

  if (msg.type === 'chat_send' && chatId) {
    const s = chats.get(chatId);
    if (!s) { ws.send(JSON.stringify({ type: 'chat_event', chatId, event: { kind: 'error', text: 'Сессия не найдена' } })); return true; }
    s.ws = ws;
    if (s.proc) { send(s, { type: 'chat_event', chatId, event: { kind: 'error', text: 'Агент ещё отвечает — дождись или нажми «Стоп».' } }); return true; }

    const text = msg.text || '';
    s.history.push({ role: 'user', text });

    let finalText = '';
    let streamed = '';   // накопленные дельты — фолбэк, если result пустой
    let errText = '';
    s.proc = runClaude({
      cwd: s.cwd, prompt: text, agent: s.agent, sessionId: s.sessionId, partial: true,
      onEvent: ev => {
        if (ev.kind === 'init') { s.sessionId = ev.sessionId; persist(chatId, s); }
        else if (ev.kind === 'tool') { s.history.push({ role: 'tool', text: ev.arg, name: ev.name }); send(s, { type: 'chat_event', chatId, event: ev }); }
        else if (ev.kind === 'delta') { streamed += ev.text; send(s, { type: 'chat_event', chatId, event: ev }); }
        else if (ev.kind === 'assistant') finalText = ev.text;
        else if (ev.kind === 'error') { errText = ev.text; send(s, { type: 'chat_event', chatId, event: ev }); }
        else if (ev.kind === 'done') {
          s.proc = null;
          const answer = finalText || streamed;
          if (answer) {
            s.history.push({ role: 'assistant', text: answer });
            send(s, { type: 'chat_event', chatId, event: { kind: 'assistant', text: answer } });
          } else if (!errText && ev.code !== 0) {
            send(s, { type: 'chat_event', chatId, event: { kind: 'error', text: 'Агент завершился с ошибкой.' } });
          }
          send(s, { type: 'chat_event', chatId, event: { kind: 'done' } });
          persist(chatId, s);
        }
      },
    });
    return true;
  }

  if (msg.type === 'chat_cancel' && chatId) {
    const s = chats.get(chatId);
    if (s?.proc) { try { s.proc.kill(); } catch { /* ignore */ } }
    return true;
  }

  // «Новый диалог» — сбросить контекст (--resume), сохранив сессию.
  if (msg.type === 'chat_reset' && chatId) {
    const s = chats.get(chatId);
    if (s) {
      if (s.proc) { try { s.proc.kill(); } catch { /* ignore */ } s.proc = null; }
      s.sessionId = null;
      s.history = [];
      persist(chatId, s);
      send(s, { type: 'chat_restore', chatId, messages: [] });
    }
    return true;
  }

  if (msg.type === 'chat_close' && chatId) {
    const s = chats.get(chatId);
    if (s) {
      if (s.killTimer) clearTimeout(s.killTimer);
      if (s.proc) { try { s.proc.kill(); } catch { /* ignore */ } }
      chats.delete(chatId);
    }
    return true;
  }

  return false;
}

// ws закрылся без chat_close — отвязываем, сессию держим ради переподключения, GC через таймер.
export function detachChatWs(ws: WebSocket): void {
  for (const [id, s] of chats) {
    if (s.ws === ws) {
      s.ws = null;
      if (s.killTimer) clearTimeout(s.killTimer);
      s.killTimer = setTimeout(() => {
        if (s.proc) { try { s.proc.kill(); } catch { /* ignore */ } }
        chats.delete(id);
      }, DETACH_GC_MS);
    }
  }
}
