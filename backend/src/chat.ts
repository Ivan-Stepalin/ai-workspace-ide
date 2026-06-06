// Нативный чат с агентом в браузере: headless `claude` (см. agent-stream.ts), события
// которого нормализуются и шлются в браузер по WebSocket как chat_event. Контекст диалога
// держится через --resume (session_id из события init). Источник истины — сервер: живые
// сессии лежат в памяти (Map), а история сообщений + session_id персистятся в workspace.db
// (chat_sessions + chat_messages), поэтому диалог переживает и переподключение из свежей
// вкладки, и перезапуск бэкенда. История чистится по ретенции (старше CHAT_RETENTION_MS).
import { WebSocket } from 'ws';
import { ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { getProject, PROJECTS_DIR, DB_PATH } from './projects.js';
import { runClaude } from './agent-stream.js';
import { roleNoteFor } from './agents.js';
import { Action } from './permissions.js';
import { WsMessage } from './types.js';

const DETACH_GC_MS = 30 * 60 * 1000;
const RETENTION_MS = Number(process.env.CHAT_RETENTION_MS) || 7 * 24 * 60 * 60 * 1000;     // окно хранения истории
const SWEEP_MS = Number(process.env.CHAT_RETENTION_SWEEP_MS) || 60 * 60 * 1000;            // период чистки

export interface ChatMsg { role: 'user' | 'assistant' | 'tool'; text: string; name?: string }
interface ChatSession {
  workspaceId: string;          // projectId или 'overseer'
  userId: string | null;        // владелец чата (приватность); null — легаси/общий
  agent: string;
  cwd: string;
  roleNote?: string;            // ролевая надстройка промпта (роль пользователя)
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
    user_id TEXT,
    agent TEXT,
    session_id TEXT,
    updated_at INTEGER
  )`);
  // Миграция старых БД: чат теперь привязан к пользователю (приватность). Старые строки → user_id NULL (легаси-общие).
  try { db.exec('ALTER TABLE chat_sessions ADD COLUMN user_id TEXT'); } catch { /* колонка уже есть */ }
  // Сообщения — отдельной таблицей (а не JSON-блобом), чтобы чистка по дате была тривиальной.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at)`);
  pruneOldMessages();
  setInterval(pruneOldMessages, SWEEP_MS).unref();
}

// Удалить сообщения старше окна ретенции и осиротевшие/пустые сессии.
export function pruneOldMessages(): void {
  if (!db) return;
  const cutoff = Date.now() - RETENTION_MS;
  const del = db.prepare('DELETE FROM chat_messages WHERE created_at < ?').run(cutoff);
  // Сессии без сообщений и давно не обновлявшиеся больше не нужны (их session_id для --resume протух).
  db.prepare(`DELETE FROM chat_sessions WHERE updated_at < ?
    AND chat_id NOT IN (SELECT DISTINCT chat_id FROM chat_messages)`).run(cutoff);
  if (del.changes) console.log(`[chat] ретенция: удалено ${del.changes} сообщений старше ${Math.round(RETENTION_MS / 86400000)} дн.`);
}

function persistSession(chatId: string, s: ChatSession): void {
  if (!db) return;
  db.prepare(`INSERT INTO chat_sessions (chat_id, workspace_id, user_id, agent, session_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id, user_id=excluded.user_id,
      agent=excluded.agent, session_id=excluded.session_id, updated_at=excluded.updated_at`)
    .run(chatId, s.workspaceId, s.userId, s.agent, s.sessionId, Date.now());
}

function persistMsg(chatId: string, m: ChatMsg): void {
  if (!db) return;
  db.prepare('INSERT INTO chat_messages (chat_id, role, content, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, m.role, m.text, m.name ?? null, Date.now());
}

function loadHistory(chatId: string): ChatMsg[] {
  if (!db) return [];
  const rows = db.prepare('SELECT role, content, name FROM chat_messages WHERE chat_id = ? ORDER BY id ASC').all(chatId) as { role: ChatMsg['role']; content: string; name: string | null }[];
  return rows.map(r => ({ role: r.role, text: r.content, ...(r.name ? { name: r.name } : {}) }));
}

function dropPersisted(chatId: string): void {
  if (!db) return;
  db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM chat_sessions WHERE chat_id = ?').run(chatId);
}

function send(s: ChatSession, data: object): void {
  if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(data));
}

// Список чат-сессий воркспейса ДЛЯ ДАННОГО ПОЛЬЗОВАТЕЛЯ (приватность): живые из памяти +
// персистированные с непустой историей. Видны только свои чаты (+ легаси с user_id IS NULL).
export function listChats(workspaceId: string, userId?: string): { id: string; agent: string }[] {
  const owns = (owner: string | null) => owner == null || owner === userId;
  const out = new Map<string, string>();
  for (const [id, s] of chats) if (s.workspaceId === workspaceId && owns(s.userId)) out.set(id, s.agent);
  if (db) {
    const rows = db.prepare(`SELECT chat_id, user_id, agent FROM chat_sessions
      WHERE workspace_id = ? AND (user_id IS NULL OR user_id = ?)
      AND chat_id IN (SELECT DISTINCT chat_id FROM chat_messages)`).all(workspaceId, userId ?? null) as { chat_id: string; user_id: string | null; agent: string }[];
    for (const r of rows) if (!out.has(r.chat_id)) out.set(r.chat_id, r.agent || 'manager');
  }
  return [...out.entries()].map(([id, agent]) => ({ id, agent }));
}

// Возвращает true, если сообщение относится к чату и обработано.
// user — аутентифицированный пользователь WS (роль/права для надстройки промпта + id для приватности чата).
export function handleChatWs(ws: WebSocket, msg: WsMessage, user?: { id?: string; role: string; permissions?: Action[] } | null): boolean {
  const chatId = msg.chatId;
  const uid = user?.id ?? null;
  // Доступ к чату: только владелец (или легаси-чат без владельца — он общий).
  const owns = (s: ChatSession) => s.userId == null || s.userId === uid;

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
    const roleNote = user?.role ? roleNoteFor(user.role, user.permissions) : undefined;

    let s = chats.get(chatId);
    if (s) {
      if (!owns(s)) { ws.send(JSON.stringify({ type: 'chat_event', chatId, event: { kind: 'error', text: 'Чат принадлежит другому пользователю' } })); return true; }
      // переподключение к живой сессии: гасим GC, перевязываем ws
      if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
      s.ws = ws;
      if (s.userId == null) s.userId = uid;   // легаси-чат закрепляем за первым открывшим
      if (roleNote) s.roleNote = roleNote;
    } else {
      // нет в памяти — поднимаем из БД (история + session_id переживают рестарт)
      const row = db?.prepare('SELECT session_id, user_id FROM chat_sessions WHERE chat_id = ?').get(chatId) as { session_id: string | null; user_id: string | null } | undefined;
      if (row && row.user_id != null && row.user_id !== uid) { ws.send(JSON.stringify({ type: 'chat_event', chatId, event: { kind: 'error', text: 'Чат принадлежит другому пользователю' } })); return true; }
      s = { workspaceId, userId: row?.user_id ?? uid, agent, cwd, roleNote, sessionId: row?.session_id ?? null, history: loadHistory(chatId), proc: null, ws, killTimer: null };
      chats.set(chatId, s);
    }
    ws.send(JSON.stringify({ type: 'chat_ready', chatId }));
    if (s.history.length) ws.send(JSON.stringify({ type: 'chat_restore', chatId, messages: s.history }));
    return true;
  }

  if (msg.type === 'chat_send' && chatId) {
    const s = chats.get(chatId);
    if (!s) { ws.send(JSON.stringify({ type: 'chat_event', chatId, event: { kind: 'error', text: 'Сессия не найдена' } })); return true; }
    if (!owns(s)) { ws.send(JSON.stringify({ type: 'chat_event', chatId, event: { kind: 'error', text: 'Нет доступа к этому чату' } })); return true; }
    s.ws = ws;
    if (s.proc) { send(s, { type: 'chat_event', chatId, event: { kind: 'error', text: 'Агент ещё отвечает — дождись или нажми «Стоп».' } }); return true; }

    const text = msg.text || '';
    const userMsg: ChatMsg = { role: 'user', text };
    s.history.push(userMsg);
    persistMsg(chatId, userMsg);

    let finalText = '';
    let streamed = '';   // накопленные дельты — фолбэк, если result пустой
    let errText = '';
    s.proc = runClaude({
      cwd: s.cwd, prompt: text, agent: s.agent, roleNote: s.roleNote, sessionId: s.sessionId, partial: true,
      onEvent: ev => {
        if (ev.kind === 'init') { s.sessionId = ev.sessionId; persistSession(chatId, s); }
        else if (ev.kind === 'tool') { const m: ChatMsg = { role: 'tool', text: ev.arg, name: ev.name }; s.history.push(m); persistMsg(chatId, m); send(s, { type: 'chat_event', chatId, event: ev }); }
        else if (ev.kind === 'delta') { streamed += ev.text; send(s, { type: 'chat_event', chatId, event: ev }); }
        else if (ev.kind === 'assistant') finalText = ev.text;
        else if (ev.kind === 'error') { errText = ev.text; send(s, { type: 'chat_event', chatId, event: ev }); }
        else if (ev.kind === 'done') {
          s.proc = null;
          const answer = finalText || streamed;
          if (answer) {
            const m: ChatMsg = { role: 'assistant', text: answer };
            s.history.push(m); persistMsg(chatId, m);
            send(s, { type: 'chat_event', chatId, event: { kind: 'assistant', text: answer } });
          } else if (!errText && ev.code !== 0) {
            send(s, { type: 'chat_event', chatId, event: { kind: 'error', text: 'Агент завершился с ошибкой.' } });
          }
          send(s, { type: 'chat_event', chatId, event: { kind: 'done' } });
          persistSession(chatId, s);
        }
      },
    });
    return true;
  }

  if (msg.type === 'chat_cancel' && chatId) {
    const s = chats.get(chatId);
    if (s && owns(s) && s.proc) { try { s.proc.kill(); } catch { /* ignore */ } }
    return true;
  }

  // «Новый диалог» — сбросить контекст (--resume) и историю, сохранив саму сессию.
  if (msg.type === 'chat_reset' && chatId) {
    const s = chats.get(chatId);
    if (s && owns(s)) {
      if (s.proc) { try { s.proc.kill(); } catch { /* ignore */ } s.proc = null; }
      s.sessionId = null;
      s.history = [];
      dropPersisted(chatId);
      send(s, { type: 'chat_restore', chatId, messages: [] });
    }
    return true;
  }

  // Закрытие вкладки — гасим сессию и удаляем её историю из БД (только своего чата).
  if (msg.type === 'chat_close' && chatId) {
    const s = chats.get(chatId);
    if (s) {
      if (!owns(s)) return true;
      if (s.killTimer) clearTimeout(s.killTimer);
      if (s.proc) { try { s.proc.kill(); } catch { /* ignore */ } }
      chats.delete(chatId);
    } else if (db) {
      // нет в памяти — проверим владельца в БД, чтобы не удалить чужую историю
      const row = db.prepare('SELECT user_id FROM chat_sessions WHERE chat_id = ?').get(chatId) as { user_id: string | null } | undefined;
      if (row && row.user_id != null && row.user_id !== uid) return true;
    }
    dropPersisted(chatId);
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
