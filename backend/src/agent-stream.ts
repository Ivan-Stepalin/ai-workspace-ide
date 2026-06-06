// Общий раннер агента в headless-режиме: `claude -p ... --output-format stream-json`.
// Парсит поток NDJSON-событий и отдаёт их потребителю уже НОРМАЛИЗОВАННЫМИ
// (init / tool / delta / assistant / error / done). Используется и chat.ts (браузер),
// и telegram.ts — единая точка спавна и разбора, без дублирования логики.
import { spawn, ChildProcess } from 'child_process';
import { PROMPTS } from './agents.js';

// Нормализованное событие диалога. Текст ответа берём из финального `result`
// (а не из промежуточных assistant-блоков) — иначе он задвоится с дельтами стрима.
export type AgentEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'tool'; name: string; arg: string }
  | { kind: 'delta'; text: string }            // токеновый стрим (только при partial)
  | { kind: 'assistant'; text: string }        // финальный ответ
  | { kind: 'error'; text: string }
  | { kind: 'done'; code: number | null };

export interface RunOptions {
  cwd: string;
  prompt: string;
  agent: string;                // ключ PROMPTS; {p} заменяется на cwd
  roleNote?: string;            // ролевая надстройка к системному промпту (роль пользователя)
  sessionId?: string | null;    // для --resume (продолжение контекста)
  partial?: boolean;            // --include-partial-messages → токеновый стрим
  onEvent: (ev: AgentEvent) => void;
}

// Запустить агента и стримить нормализованные события в onEvent. Возвращает процесс
// (чтобы можно было прервать через .kill()). На exit гарантированно шлёт {kind:'done'}.
export function runClaude(opts: RunOptions): ChildProcess {
  let sys = (PROMPTS[opts.agent] || PROMPTS.manager).replace(/{p}/g, opts.cwd);
  if (opts.roleNote) sys += ' ' + opts.roleNote;
  const args = ['-p', opts.prompt, '--append-system-prompt', sys,
    '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (opts.partial) args.push('--include-partial-messages');
  if (opts.sessionId) args.push('--resume', opts.sessionId);

  const proc = spawn('claude', args, { cwd: opts.cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';        // сборка NDJSON-строк из чанков stdout
  let errText = '';

  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line, opts.onEvent);
    }
  });
  proc.stderr!.on('data', (d: Buffer) => { errText += d.toString(); });

  proc.on('exit', code => {
    if (code !== 0 && errText.trim()) opts.onEvent({ kind: 'error', text: errText.slice(-1000) });
    opts.onEvent({ kind: 'done', code });
  });
  proc.on('error', e => {
    opts.onEvent({ kind: 'error', text: String(e) });
    opts.onEvent({ kind: 'done', code: null });
  });

  return proc;
}

// Разбор одной NDJSON-строки stream-json в нормализованное событие.
function handleLine(line: string, emit: (ev: AgentEvent) => void): void {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return; }

  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
    emit({ kind: 'init', sessionId: ev.session_id });
    return;
  }
  // Из assistant-события берём только вызовы инструментов; текст ответа — из result.
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        const arg = block.input?.file_path || block.input?.path || block.input?.command || block.input?.pattern || '';
        emit({ kind: 'tool', name: block.name, arg: String(arg).slice(0, 200) });
      }
    }
    return;
  }
  // Токеновый стрим (--include-partial-messages): дельты текста ассистента.
  if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
    const text = ev.event.delta?.text;
    if (typeof text === 'string' && text) emit({ kind: 'delta', text });
    return;
  }
  if (ev.type === 'result' && typeof ev.result === 'string') {
    emit({ kind: 'assistant', text: ev.result });
  }
}
