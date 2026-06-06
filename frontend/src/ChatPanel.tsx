import { useEffect, useRef, useState, useCallback, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import { WS_URL } from './config'
import { agentColors, agentLabel, OVERSEER } from './theme'
import { can, Role as UserRole, Action } from './auth'

interface Props {
  projectId: string
  agent: string
  wsId: string              // = chatId; стабильный id серверной сессии для переподключения
  role: UserRole            // роль пользователя — фильтрует набор стандартных команд
  active?: boolean
}

// Стандартные команды в селекте у поля ввода. send=true → сразу отправить; иначе вставить в поле.
// need — capability-гейт: команда видна, только если роль её разрешает.
type Cmd = { id: string; label: string; prompt: string; send?: boolean; need?: Action }
const COMMANDS: Cmd[] = [
  { id: 'status', label: 'git status', prompt: 'Покажи git status.', send: true },
  { id: 'diff', label: 'Показать изменения (diff)', prompt: 'Покажи незакоммиченные изменения (git diff).', send: true },
  { id: 'tests', label: 'Запустить тесты', prompt: 'Запусти тесты проекта и покажи результат.', send: true },
  { id: 'build', label: 'Собрать проект', prompt: 'Собери проект и покажи результат сборки.', send: true },
  { id: 'explain', label: 'Объясни структуру проекта', prompt: 'Кратко объясни структуру и назначение этого проекта.', send: true },
  { id: 'commit', label: 'Закоммитить изменения', prompt: 'Закоммить текущие изменения с осмысленным сообщением.', send: true, need: 'git.commit' },
]

type Role = 'user' | 'assistant' | 'tool'
interface ChatMessage { role: Role; text: string; name?: string; streaming?: boolean }
// нормализованное chat_event с бэкенда (см. agent-stream.ts AgentEvent)
type ChatEvent =
  | { kind: 'tool'; name: string; arg: string }
  | { kind: 'delta'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done' }

// Блок кода с кнопкой «копировать» (rehype-highlight уже разметил подсветку внутри).
function Pre({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const t = ref.current?.innerText ?? ''
    navigator.clipboard?.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {})
  }
  return (
    <div className="group relative">
      <button onClick={copy} className="absolute right-2 top-2 z-10 rounded border border-edge bg-app/80 px-2 py-0.5 text-[11px] text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100">
        {copied ? '✓ скопировано' : 'копировать'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function ChatPanel({ projectId, agent, wsId, role, active }: Props) {
  const wsRef = useRef<WebSocket | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const isOverseer = agent === OVERSEER

  const send = useCallback((data: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
  }, [])

  // Применяем нормализованное событие к ленте сообщений.
  const applyEvent = useCallback((ev: ChatEvent) => {
    if (ev.kind === 'tool') {
      setMessages(m => [...m, { role: 'tool', text: ev.arg, name: ev.name }])
    } else if (ev.kind === 'delta') {
      setMessages(m => {
        const last = m[m.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          return [...m.slice(0, -1), { ...last, text: last.text + ev.text }]
        }
        return [...m, { role: 'assistant', text: ev.text, streaming: true }]
      })
    } else if (ev.kind === 'assistant') {
      // финальный авторитетный текст — заменяем накопленный стрим
      setMessages(m => {
        const last = m[m.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          return [...m.slice(0, -1), { ...last, text: ev.text }]
        }
        return [...m, { role: 'assistant', text: ev.text, streaming: true }]
      })
    } else if (ev.kind === 'error') {
      setMessages(m => [...m, { role: 'assistant', text: '⚠️ ' + ev.text }])
    } else if (ev.kind === 'done') {
      setBusy(false)
      setMessages(m => m.map(x => x.streaming ? { ...x, streaming: false } : x))
    }
  }, [])

  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'chat_create', chatId: wsId, projectId, agent }))
    ws.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.chatId && data.chatId !== wsId) return
      if (data.type === 'chat_ready') setReady(true)
      else if (data.type === 'chat_restore') {
        setMessages((data.messages as ChatMessage[]) || [])
        setBusy(false)
      } else if (data.type === 'chat_event') {
        applyEvent(data.event as ChatEvent)
      }
    }
    return () => ws.close()
  }, [projectId, agent, wsId, applyEvent])

  // автоскролл вниз при новых сообщениях
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  useEffect(() => { if (active) taRef.current?.focus() }, [active])

  function submit(textArg?: string) {
    const text = (textArg ?? input).trim()
    if (!text || busy || !ready) return
    setMessages(m => [...m, { role: 'user', text }])
    send({ type: 'chat_send', chatId: wsId, text })
    setBusy(true)
    if (textArg === undefined) setInput('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  const stop = () => send({ type: 'chat_cancel', chatId: wsId })
  const reset = () => { send({ type: 'chat_reset', chatId: wsId }); setMessages([]); setBusy(false) }

  const cmds = COMMANDS.filter(c => !c.need || can(role, c.need))
  function runCommand(id: string) {
    const cmd = cmds.find(c => c.id === id)
    if (!cmd) return
    if (cmd.send) submit(cmd.prompt)
    else { setInput(cmd.prompt); taRef.current?.focus() }
  }

  const color = agentColors[agent] || agentColors.manager
  const label = isOverseer ? '🧭 Общий менеджер' : '🤖 ' + agentLabel(agent)
  const streamingNow = busy && !messages.some(m => m.streaming)

  return (
    <div className="flex h-full w-full flex-col bg-app">
      <style>{chatStyles}</style>

      {/* Шапка чата */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge bg-sidebar px-4 py-2">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[13px] font-medium text-fg">{label}</span>
        <button onClick={reset} title="Сбросить контекст диалога" className="ml-auto rounded border border-edge px-2 py-0.5 text-[12px] text-muted transition-colors hover:bg-white/5 hover:text-fg">Новый диалог</button>
      </div>

      {/* Лента сообщений */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
            <div className="text-[28px]">{isOverseer ? '🧭' : '🤖'}</div>
            <div className="text-sm">{ready ? 'Напиши агенту, что нужно сделать' : 'Подключение…'}</div>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'tool') {
            return (
              <div key={i} className="flex items-center gap-2 px-1 font-mono text-[11px] text-dim">
                <span>🔧</span>
                <span className="text-muted">{m.name}</span>
                {m.text && <span className="truncate">· {m.text}</span>}
              </div>
            )
          }
          const mine = m.role === 'user'
          return (
            <div key={i} className={'flex ' + (mine ? 'justify-end' : 'justify-start')}>
              <div
                className={
                  'max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ' +
                  (mine ? 'bg-accent text-white' : 'border border-edge bg-sidebar text-fg')
                }
              >
                {mine ? (
                  <span className="whitespace-pre-wrap break-words">{m.text}</span>
                ) : (
                  <div className="chat-md break-words">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: Pre }}>
                      {m.text}
                    </ReactMarkdown>
                    {m.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle" />}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {streamingNow && (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-edge bg-sidebar px-3.5 py-2 text-[13px] text-muted">
              агент печатает<span className="animate-pulse">…</span>
            </div>
          </div>
        )}
      </div>

      {/* Поле ввода */}
      <div className="flex flex-shrink-0 items-end gap-2 border-t border-edge bg-sidebar px-3 py-2.5">
        {cmds.length > 0 && (
          <select
            value=""
            onChange={e => { runCommand(e.target.value); e.currentTarget.value = '' }}
            disabled={!ready || busy}
            title="Стандартные команды"
            className="h-[40px] flex-shrink-0 rounded-lg border border-edge bg-app px-2 text-[12px] text-muted outline-none transition-colors hover:text-fg focus:border-accent disabled:opacity-50"
          >
            <option value="" disabled>⚙ Команды</option>
            {cmds.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        )}
        <textarea
          ref={taRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={ready ? 'Сообщение агенту…  (Enter — отправить, Shift+Enter — перенос)' : 'Подключение…'}
          disabled={!ready}
          className="max-h-40 min-h-[40px] flex-1 resize-none rounded-lg border border-edge bg-app px-3 py-2 text-[13px] text-fg outline-none transition-colors placeholder:text-dim focus:border-accent disabled:opacity-50"
        />
        {busy ? (
          <button onClick={stop} className="rounded-lg border border-edge bg-app px-4 py-2 text-[13px] text-fg transition hover:bg-white/5">Стоп</button>
        ) : (
          <button onClick={() => submit()} disabled={!ready || !input.trim()} className="rounded-lg bg-accent px-4 py-2 text-[13px] text-white transition hover:brightness-110 disabled:opacity-40">Отправить</button>
        )}
      </div>
    </div>
  )
}

// Скоупленные стили markdown-контента ассистента (react-markdown рендерит обычный HTML —
// Tailwind-утилиты до него не достают, поэтому стилизуем селекторами, как у xterm).
const chatStyles = `
.chat-md > *:first-child { margin-top: 0; }
.chat-md > *:last-child { margin-bottom: 0; }
.chat-md p { margin: 0.4em 0; }
.chat-md ul, .chat-md ol { margin: 0.4em 0; padding-left: 1.3em; }
.chat-md li { margin: 0.15em 0; }
.chat-md h1, .chat-md h2, .chat-md h3 { margin: 0.6em 0 0.3em; font-weight: 600; line-height: 1.3; }
.chat-md h1 { font-size: 1.25em; } .chat-md h2 { font-size: 1.15em; } .chat-md h3 { font-size: 1.05em; }
.chat-md a { color: #4fc3f7; text-decoration: underline; }
.chat-md code { font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: 0.92em; background: rgba(255,255,255,0.08); padding: 0.1em 0.35em; border-radius: 4px; }
.chat-md pre { margin: 0.5em 0; padding: 0.75em 0.9em; border-radius: 8px; overflow-x: auto; background: #0d0d0d; border: 1px solid var(--color-edge, #2a2a2a); }
.chat-md pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.5; }
.chat-md blockquote { margin: 0.4em 0; padding-left: 0.8em; border-left: 3px solid var(--color-edge, #2a2a2a); color: var(--color-muted, #999); }
.chat-md table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.92em; }
.chat-md th, .chat-md td { border: 1px solid var(--color-edge, #2a2a2a); padding: 0.3em 0.6em; }
.chat-md hr { border: none; border-top: 1px solid var(--color-edge, #2a2a2a); margin: 0.7em 0; }
`

// memo: ререндеры App не должны трогать живые чаты; пересоздаём только при смене сессии.
export default memo(ChatPanel, (a, b) =>
  a.projectId === b.projectId && a.agent === b.agent && a.wsId === b.wsId && a.role === b.role && a.active === b.active)
