import { useEffect, useRef, useState, useCallback, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import clsx from 'clsx'
import { WS_URL } from './config'
import { agentColors, agentLabel, OVERSEER } from './theme'
import { Action } from './auth'
import s from './ChatPanel.module.css'

interface Props {
  projectId: string
  agent: string
  wsId: string              // = chatId; стабильный id серверной сессии для переподключения
  perms: Action[]           // права пользователя — фильтруют набор стандартных команд
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
    <div className={s.codeWrap}>
      <button onClick={copy} className={s.copyBtn}>
        {copied ? '✓ скопировано' : 'копировать'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function ChatPanel({ projectId, agent, wsId, perms, active }: Props) {
  const wsRef = useRef<WebSocket | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const cmdRef = useRef<HTMLDivElement>(null)
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

  // закрытие меню команд по клику вне и по Escape
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!cmdRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

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

  const cmds = COMMANDS.filter(c => !c.need || perms.includes(c.need))
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
    <div className={s.container}>
      <style>{chatStyles}</style>

      {/* Шапка чата */}
      <div className={s.header}>
        <span className={s.dot} style={{ backgroundColor: color }} />
        <span className={s.headerLabel}>{label}</span>
        <button onClick={reset} title="Сбросить контекст диалога" className={s.resetBtn}>Новый диалог</button>
      </div>

      {/* Лента сообщений */}
      <div ref={scrollRef} className={s.scroll}>
        {messages.length === 0 && (
          <div className={s.empty}>
            <div className={s.emptyIcon}>{isOverseer ? '🧭' : '🤖'}</div>
            <div>{ready ? 'Напиши агенту, что нужно сделать' : 'Подключение…'}</div>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'tool') {
            return (
              <div key={i} className={s.toolRow}>
                <span>🔧</span>
                <span className={s.toolName}>{m.name}</span>
                {m.text && <span className={s.toolArg}>· {m.text}</span>}
              </div>
            )
          }
          const mine = m.role === 'user'
          return (
            <div key={i} className={clsx(s.row, mine ? s.rowMine : s.rowOther)}>
              <div className={clsx(s.bubble, mine ? s.bubbleMine : s.bubbleOther)}>
                {mine ? (
                  <span className={s.userText}>{m.text}</span>
                ) : (
                  <div className={clsx('chat-md', s.mdWrap)}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: Pre }}>
                      {m.text}
                    </ReactMarkdown>
                    {m.streaming && <span className={s.cursor} />}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {streamingNow && (
          <div className={clsx(s.row, s.rowOther)}>
            <div className={s.typing}>агент печатает…</div>
          </div>
        )}
      </div>

      {/* Поле ввода */}
      <div className={s.inputBar}>
        {cmds.length > 0 && (
          <div className={s.cmdWrap} ref={cmdRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              disabled={!ready || busy}
              title="Стандартные команды"
              className={s.cmdBtn}
            >
              <span>⚙ Команды</span>
              <span className={clsx(s.cmdChevron, menuOpen && s.cmdChevronOpen)}>⌄</span>
            </button>
            {menuOpen && (
              <div className={s.cmdMenu} role="menu">
                {cmds.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); runCommand(c.id) }}
                    className={s.cmdItem}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <textarea
          ref={taRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={ready ? 'Сообщение агенту…  (Enter — отправить, Shift+Enter — перенос)' : 'Подключение…'}
          disabled={!ready}
          className={s.textarea}
        />
        {busy ? (
          <button onClick={stop} className={s.stopBtn}>Стоп</button>
        ) : (
          <button onClick={() => submit()} disabled={!ready || !input.trim()} className={s.sendBtn}>Отправить</button>
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
  a.projectId === b.projectId && a.agent === b.agent && a.wsId === b.wsId
  && a.perms.join(',') === b.perms.join(',') && a.active === b.active)
