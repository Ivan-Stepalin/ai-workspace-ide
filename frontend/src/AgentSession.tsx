import { useEffect, useRef } from 'react'
import { C, agentColors, statusLabels, agentLabel, Message } from './theme'

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

  const color = agentColors[agentType] || C.text
  const label = agentLabel(agentType)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: C.textDim, fontSize: 13, textAlign: 'center', marginTop: 40 }}>
            Напиши задачу — агент «{label}» начнёт работу
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {m.role === 'agent' && <div style={{ fontSize: 11, color, marginBottom: 4, fontWeight: 600 }}>{label.toUpperCase()}</div>}
            <div style={{ maxWidth: '80%', padding: '8px 12px', borderRadius: 4, fontSize: 13, lineHeight: 1.6, background: m.role === 'user' ? C.accentBg : C.msgAgent, color: C.text, border: '1px solid ' + (m.role === 'user' ? C.accent : C.border), whiteSpace: 'pre-wrap', fontFamily: m.role === 'agent' ? "'Consolas', monospace" : 'inherit' }}>
              {m.text}{m.streaming ? <span style={{ color: C.accent }}>▍</span> : ''}
            </div>
          </div>
        ))}
        {status && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ fontSize: 11, color, marginBottom: 4, fontWeight: 600 }}>{label.toUpperCase()}</div>
            <div style={{ padding: '6px 12px', borderRadius: 4, fontSize: 12, background: '#2a2a2a', border: '1px solid ' + C.border, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: status === 'done' ? C.green : status === 'error' ? '#f44747' : C.accent }} />
              {statusLabels[status] || status}
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div style={{ borderTop: '1px solid ' + C.border, padding: '8px 12px', display: 'flex', gap: 8, background: C.sidebar, flexShrink: 0, alignItems: 'center' }}>
        <span style={{ fontSize: 12, padding: '4px 8px', borderRadius: 3, border: '1px solid ' + C.border, background: C.inputBg, color, fontWeight: 600, whiteSpace: 'nowrap' }}>🤖 {label}</span>
        <input
          value={input}
          onChange={e => onInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() } }}
          placeholder="Напиши задачу... (Enter для отправки)"
          style={{ flex: 1, padding: '6px 10px', borderRadius: 3, border: '1px solid ' + C.border, fontSize: 13, background: C.inputBg, color: C.text, outline: 'none' }}
        />
        <button onClick={onSend} disabled={streaming} style={{ padding: '6px 14px', borderRadius: 3, border: '1px solid ' + C.accent, cursor: streaming ? 'not-allowed' : 'pointer', fontSize: 13, background: streaming ? C.inputBg : C.accentBg, color: streaming ? C.textMuted : '#fff' }}>→</button>
      </div>
    </div>
  )
}
