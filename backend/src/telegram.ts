// Telegram-бот: тот же набор агентов, что в браузерной IDE, но в headless-режиме.
// Каждый чат привязывается к { проект, роль } и ведёт диалог с `claude -p` через --resume,
// держа контекст между сообщениями. Вывод stream-json превращается в сообщения чата.
//
// Включается только если задан TELEGRAM_BOT_TOKEN. Транспорт — long polling (без публичного домена).
import TelegramBot from 'node-telegram-bot-api';
import { ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { listProjects, getProject, PROJECTS_DIR, DB_PATH } from './projects.js';
import { runClaude } from './agent-stream.js';

const AGENTS = ['manager', 'overseer'] as const;
const AGENT_LABELS: Record<string, string> = {
  manager: 'Агент', overseer: 'Общий менеджер',
};
const TG_MAX = 4096; // лимит длины сообщения Telegram

// Состояние чата живёт в той же workspace.db (переживает перезапуск бэкенда).
interface ChatState { chat_id: string; project_id: string | null; agent: string | null; session_id: string | null; }

let bot: TelegramBot | null = null;
let db: Database.Database | null = null;
const running: Record<string, ChildProcess> = {}; // активный claude-процесс на чат (chat_id → proc)
const allowed = new Set<string>(); // разрешённые chat_id; пустой набор = доступ закрыт всем

// Доступ только для chat_id из TELEGRAM_ALLOWED_CHAT_IDS. Незнакомому чату сообщаем его id,
// чтобы его можно было добавить в whitelist. Возвращает true, если чату можно продолжать.
function guard(chatId: number): boolean {
  if (allowed.has(String(chatId))) return true;
  bot!.sendMessage(chatId,
    '⛔ Доступ закрыт. Твой chat_id: ' + chatId +
    '\nДобавь его в TELEGRAM_ALLOWED_CHAT_IDS (через запятую) и перезапусти бэкенд.').catch(() => {});
  return false;
}

function initDb(): void {
  db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS tg_sessions (
    chat_id TEXT PRIMARY KEY,
    project_id TEXT,
    agent TEXT,
    session_id TEXT
  )`);
}

function getState(chatId: number | string): ChatState {
  const id = String(chatId);
  const row = db!.prepare('SELECT * FROM tg_sessions WHERE chat_id = ?').get(id) as ChatState | undefined;
  return row || { chat_id: id, project_id: null, agent: null, session_id: null };
}

function saveState(s: ChatState): void {
  db!.prepare(`INSERT INTO tg_sessions (chat_id, project_id, agent, session_id) VALUES (@chat_id, @project_id, @agent, @session_id)
    ON CONFLICT(chat_id) DO UPDATE SET project_id=@project_id, agent=@agent, session_id=@session_id`).run(s);
}

// Telegram режет сообщения длиннее 4096 символов — отправляем по частям.
async function sendChunked(chatId: number, text: string): Promise<void> {
  if (!text.trim()) return;
  for (let i = 0; i < text.length; i += TG_MAX) {
    await bot!.sendMessage(chatId, text.slice(i, i + TG_MAX)).catch(() => { /* ignore send errors */ });
  }
}

function projectsKeyboard(): TelegramBot.InlineKeyboardMarkup {
  const rows = listProjects().map(p => [{ text: p.name, callback_data: 'proj:' + p.id }]);
  return { inline_keyboard: rows.length ? rows : [[{ text: '— проектов нет —', callback_data: 'noop' }]] };
}

function agentsKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: AGENTS.map(a => [{ text: AGENT_LABELS[a], callback_data: 'agent:' + a }]) };
}

function statusLine(s: ChatState): string {
  const proj = s.project_id ? (getProject(s.project_id)?.name || s.project_id) : '—';
  const agent = s.agent ? AGENT_LABELS[s.agent] : '—';
  const ctx = s.session_id ? 'есть' : 'новый';
  return `Роль: ${agent}\nПроект: ${proj}\nКонтекст: ${ctx}`;
}

// Запуск агента в headless-режиме и стриминг ответа обратно в чат.
function runAgent(chatId: number, prompt: string): void {
  const s = getState(chatId);
  if (!s.agent) { bot!.sendMessage(chatId, 'Сначала выбери роль: /agent'); return; }
  // Все роли кроме overseer работают в папке конкретного проекта.
  let cwd: string;
  if (s.agent === 'overseer') {
    cwd = PROJECTS_DIR;
  } else {
    if (!s.project_id) { bot!.sendMessage(chatId, 'Сначала выбери проект: /projects'); return; }
    const p = getProject(s.project_id);
    if (!p) { bot!.sendMessage(chatId, 'Проект не найден, выбери заново: /projects'); return; }
    cwd = p.path;
  }
  if (running[chatId]) { bot!.sendMessage(chatId, '⏳ Агент ещё отвечает на прошлое сообщение. Дождись ответа или /cancel.'); return; }

  bot!.sendChatAction(chatId, 'typing').catch(() => {});
  const typing = setInterval(() => bot!.sendChatAction(chatId, 'typing').catch(() => {}), 5000);

  let finalText = '';  // финальный ответ
  let errText = '';
  const proc = runClaude({
    cwd, prompt, agent: s.agent, sessionId: s.session_id,
    onEvent: ev => {
      if (ev.kind === 'init') { s.session_id = ev.sessionId; saveState(s); }
      else if (ev.kind === 'tool') bot!.sendMessage(chatId, `🔧 ${ev.name}${ev.arg ? ' · ' + ev.arg.slice(0, 120) : ''}`).catch(() => {});
      else if (ev.kind === 'assistant') finalText = ev.text;
      else if (ev.kind === 'error') errText = ev.text;
      else if (ev.kind === 'done') {
        clearInterval(typing);
        delete running[chatId];
        if (finalText) sendChunked(chatId, finalText);
        else if (ev.code !== 0) sendChunked(chatId, '⚠️ Агент завершился с ошибкой.\n' + (errText || ''));
        else sendChunked(chatId, '(пустой ответ)');
      }
    },
  });
  running[chatId] = proc;
}

export function initTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return; // бот опционален
  initDb();
  for (const id of (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    allowed.add(id);
  }
  bot = new TelegramBot(token, { polling: true });

  // Меню бота (кнопка ☰ рядом с полем ввода + подсказки при наборе «/»).
  bot.setMyCommands([
    { command: 'agent', description: 'Выбрать роль агента' },
    { command: 'projects', description: 'Выбрать проект' },
    { command: 'status', description: 'Текущая привязка' },
    { command: 'reset', description: 'Сбросить контекст диалога' },
    { command: 'cancel', description: 'Прервать текущий ответ' },
    { command: 'help', description: 'Справка' },
  ]).catch(() => { /* ignore */ });

  bot.onText(/^\/(start|help)/, msg => {
    if (!guard(msg.chat.id)) return;
    bot!.sendMessage(msg.chat.id,
      'AI Workspace — агенты в Telegram.\n\n' +
      '/agent — выбрать роль (Агент / Общий менеджер)\n' +
      '/projects — выбрать проект\n' +
      '/status — текущая привязка\n' +
      '/reset — начать диалог заново (сбросить контекст)\n' +
      '/cancel — прервать текущий ответ агента\n\n' +
      'Дальше просто пиши сообщение — агент ответит в контексте выбранного проекта.');
  });

  bot.onText(/^\/agent/, msg => {
    if (!guard(msg.chat.id)) return;
    bot!.sendMessage(msg.chat.id, 'Выбери роль агента:', { reply_markup: agentsKeyboard() });
  });

  bot.onText(/^\/projects/, msg => {
    if (!guard(msg.chat.id)) return;
    bot!.sendMessage(msg.chat.id, 'Выбери проект:', { reply_markup: projectsKeyboard() });
  });

  bot.onText(/^\/status/, msg => {
    if (!guard(msg.chat.id)) return;
    bot!.sendMessage(msg.chat.id, statusLine(getState(msg.chat.id)));
  });

  bot.onText(/^\/reset/, msg => {
    if (!guard(msg.chat.id)) return;
    const s = getState(msg.chat.id);
    s.session_id = null;
    saveState(s);
    bot!.sendMessage(msg.chat.id, 'Контекст сброшен — следующее сообщение начнёт новый диалог.');
  });

  bot.onText(/^\/cancel/, msg => {
    if (!guard(msg.chat.id)) return;
    const proc = running[msg.chat.id];
    if (proc) { try { proc.kill(); } catch { /* ignore */ } bot!.sendMessage(msg.chat.id, 'Прервано.'); }
    else bot!.sendMessage(msg.chat.id, 'Нечего прерывать.');
  });

  bot.on('callback_query', q => {
    const chatId = q.message?.chat.id;
    const data = q.data || '';
    if (chatId === undefined) return;
    if (!guard(chatId)) { bot!.answerCallbackQuery(q.id).catch(() => {}); return; }
    const s = getState(chatId);
    if (data.startsWith('proj:')) {
      s.project_id = data.slice(5);
      s.session_id = null; // смена проекта = новый контекст
      saveState(s);
      bot!.answerCallbackQuery(q.id).catch(() => {});
      bot!.sendMessage(chatId, '✅ Проект выбран.\n' + statusLine(s));
    } else if (data.startsWith('agent:')) {
      s.agent = data.slice(6);
      s.session_id = null; // смена роли = новый контекст
      saveState(s);
      bot!.answerCallbackQuery(q.id).catch(() => {});
      bot!.sendMessage(chatId, '✅ Роль выбрана.\n' + statusLine(s) +
        (s.agent === 'overseer' ? '\nОбщий менеджер видит все проекты — выбор проекта не нужен.' : '\nТеперь выбери проект: /projects'));
    } else {
      bot!.answerCallbackQuery(q.id).catch(() => {});
    }
  });

  // Любое обычное сообщение (не команда) — это запрос к агенту.
  bot.on('message', msg => {
    const text = msg.text;
    if (!text || text.startsWith('/')) return;
    if (!guard(msg.chat.id)) return;
    runAgent(msg.chat.id, text);
  });

  console.log(`Telegram bot started (polling), allowed chats: ${allowed.size || 'none — access closed to all'}`);
}
