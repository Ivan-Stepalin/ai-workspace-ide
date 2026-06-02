import { useEffect } from 'react'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmModal({ open, title, message, confirmLabel = 'Подтвердить', danger, loading, onConfirm, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading, onClose])

  if (!open) return null

  const confirmCls = danger
    ? 'border-danger bg-danger/15 text-[#f48771] hover:bg-danger/25'
    : 'border-accent bg-accentbg text-white hover:brightness-125'

  return (
    <div
      onMouseDown={() => { if (!loading) onClose() }}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-sm"
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="w-[420px] max-w-[90vw] overflow-hidden rounded-xl border border-edge bg-sidebar text-fg shadow-2xl shadow-black/50 ring-1 ring-white/5"
      >
        <div className="border-b border-edge px-4 py-3 text-sm font-semibold">{title}</div>
        <div className="px-4 py-4 text-[13px] leading-relaxed text-fg whitespace-pre-wrap">{message}</div>
        <div className="flex items-center gap-2.5 border-t border-edge bg-app px-4 py-3">
          {loading && (
            <span className="flex items-center gap-2 text-xs text-muted">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-accent" />
              Удаление…
            </span>
          )}
          <button
            onClick={() => { if (!loading) onClose() }}
            disabled={loading}
            className="ml-auto rounded-md border border-edge px-3.5 py-1.5 text-[13px] text-fg transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >Отмена</button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={'rounded-md border px-4 py-1.5 text-[13px] transition disabled:cursor-not-allowed disabled:opacity-50 ' + confirmCls}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
