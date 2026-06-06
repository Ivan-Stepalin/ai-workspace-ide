import { useEffect } from 'react'
import clsx from 'clsx'
import s from './modal.module.css'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
  hideCancel?: boolean   // режим уведомления: только кнопка подтверждения
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmModal({ open, title, message, confirmLabel = 'Подтвердить', danger, loading, hideCancel, onConfirm, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading, onClose])

  if (!open) return null

  return (
    <div onMouseDown={() => { if (!loading) onClose() }} className={s.overlay}>
      <div onMouseDown={e => e.stopPropagation()} className={s.panel} style={{ width: 420 }}>
        <div className={s.header}>{title}</div>
        <div className={clsx(s.body, s.bodyPre)}>{message}</div>
        <div className={s.footer}>
          {loading && (
            <span className={s.spinnerWrap}>
              <span className={s.spinner} />
              Удаление…
            </span>
          )}
          {!hideCancel && (
            <button onClick={() => { if (!loading) onClose() }} disabled={loading} className={clsx(s.btn, s['ml-auto'])}>Отмена</button>
          )}
          <button
            onClick={onConfirm}
            disabled={loading}
            className={clsx(s.btn, danger ? s.btnDanger : s.btnPrimary, hideCancel && s['ml-auto'])}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
