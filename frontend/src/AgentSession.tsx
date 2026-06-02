import { useEffect, useRef } from 'react'
import { agentColors, statusLabels, agentLabel, Message } from './theme'

interface Props {
  agentType: string
  messages: Message[]
  status?: string
  streaming: boolean
  input: string
  onInput: (v: string) => void
  onSend: () => void
}

export default function AgentSession({ agentType, messages, status, streaming, input, onInput, onSend }: Props) {
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, status])

  const color = agentColors[agentType] || '#cccccc'
  const label = agentLabel(agentType)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mt-10 text-center text-[13px] text-dim">
            Напиши задачу — агент «{label}» начнёт работу
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={'flex flex-col ' + (m.role === 'user' ? 'items-end' : 'items-start')}>
            {m.role === 'agent' && (
              <div className="mb-1 text-[11px] font-semibold" style={{ color }}>{label.toUpperCase()}</div>
            )}
            <div
              className={
                'max-w-[80%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-[13px] leading-relaxed ' +
                (m.role === 'user'
                  ? 'border-accent bg-accentbg text-white'
                  : 'border-edge bg-field text-fg font-mono')
              }
            >
              {m.text}{m.streaming ? <span className="text-accent">▍</span> : ''}
            </div>
          </div>
        ))}
        {status && (
          <div className="flex flex-col items-start">
            <div className="mb-1 text-[11px] font-semibold" style={{ color }}>{label.toUpperCase()}</div>
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-[#2a2a2a] px-3 py-1.5 text-xs text-muted">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: status === 'done' ? '#4ec9b0' : status === 'error' ? '#f44747' : '#0078d4' }}
              />
              {statusLabels[status] || status}
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 border-t border-edge bg-sidebar px-3 py-2">
        <span
          className="whitespace-nowrap rounded-md border border-edge bg-field px-2 py-1 text-xs font-semibold"
          style={{ color }}
        >🤖 {label}</span>
        <input
          value={input}
          onChange={e => onInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() } }}
          placeholder="Напиши задачу... (Enter для отправки)"
          className="flex-1 rounded-md border border-edge bg-field px-2.5 py-1.5 text-[13px] text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/40"
        />
        <button
          onClick={onSend}
          disabled={streaming}
          className="rounded-md border border-accent bg-accentbg px-3.5 py-1.5 text-[13px] text-white transition hover:brightness-125 disabled:cursor-not-allowed disabled:border-edge disabled:bg-field disabled:text-muted"
        >→</button>
      </div>
    </div>
  )
}
