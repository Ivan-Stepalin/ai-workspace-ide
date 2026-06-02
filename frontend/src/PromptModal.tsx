import { useState, useEffect } from 'react'

export interface PromptConfig {
  title: string
  label?: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
  onSubmit: (value: string) => void
}

interface Props {
  config: PromptConfig | null
  onClose: () => void
}

export default function PromptModal({ config, onClose }: Props) {
  const [value, setValue] = useState('')

  useEffect(() => { setValue(config?.initial || '') }, [config])

  useEffect(() => {
    if (!config) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [config, onClose])

  if (!config) return null

  const submit = () => {
    const v = value.trim()
    if (!v) return
    config.onSubmit(v)
    onClose()
  }

  return (
    <div onMouseDown={onClose} className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div
        onMouseDown={e => e.stopPropagation()}
        className="w-[440px] max-w-[90vw] overflow-hidden rounded-xl border border-edge bg-sidebar text-fg shadow-2xl shadow-black/50"
      >
        <div className="border-b border-edge px-4 py-3 text-sm font-semibold">{config.title}</div>
        <div className="flex flex-col gap-2 p-4">
          {config.label && <label className="text-xs text-muted">{config.label}</label>}
          <input
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder={config.placeholder}
            className="rounded-md border border-edge bg-field px-2.5 py-2 text-[13px] text-fg outline-none transition focus:border-accent"
          />
        </div>
        <div className="flex items-center gap-2.5 border-t border-edge bg-app px-4 py-3">
          <button onClick={onClose} className="ml-auto rounded-md border border-edge px-3.5 py-1.5 text-[13px] text-fg transition hover:bg-white/5">Отмена</button>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="rounded-md border border-accent bg-accentbg px-4 py-1.5 text-[13px] text-white transition hover:brightness-125 disabled:cursor-not-allowed disabled:border-edge disabled:bg-field disabled:text-muted"
          >{config.confirmLabel || 'OK'}</button>
        </div>
      </div>
    </div>
  )
}
