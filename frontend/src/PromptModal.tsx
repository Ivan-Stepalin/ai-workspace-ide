import { useState, useEffect } from 'react'
import clsx from 'clsx'
import s from './modal.module.css'

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
    <div onMouseDown={onClose} className={s.overlay}>
      <div onMouseDown={e => e.stopPropagation()} className={s.panel} style={{ width: 440 }}>
        <div className={s.header}>{config.title}</div>
        <div className={s.body}>
          <div className={s.fields}>
            {config.label && <label className={s.label}>{config.label}</label>}
            <input
              autoFocus
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              placeholder={config.placeholder}
              className={s.field}
            />
          </div>
        </div>
        <div className={s.footer}>
          <button onClick={onClose} className={clsx(s.btn, s['ml-auto'])}>Отмена</button>
          <button onClick={submit} disabled={!value.trim()} className={clsx(s.btn, s.btnPrimary)}>{config.confirmLabel || 'OK'}</button>
        </div>
      </div>
    </div>
  )
}
