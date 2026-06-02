import { useState, useEffect } from 'react'
import axios from 'axios'
import { API } from './config'
import { Project } from './types'

interface Props {
  open: boolean
  onClose: () => void
  onAdded: (p: Project) => void
}

const field =
  'px-2.5 py-2 rounded-md border border-edge bg-field text-fg text-[13px] outline-none ' +
  'transition focus:border-accent disabled:opacity-60'

// имя проекта из ссылки: последний сегмент пути без .git ("…/Wave.git" → "Wave")
const deriveName = (u: string) => (u.trim().replace(/\/+$/, '').split('/').pop() || '').replace(/\.git$/i, '')

export default function AddRepoModal({ open, onClose, onAdded }: Props) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // сброс полей при каждом открытии
  useEffect(() => {
    if (open) { setUrl(''); setName(''); setNameTouched(false); setError(''); setLoading(false) }
  }, [open])

  // Esc закрывает (кроме момента загрузки)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading, onClose])

  if (!open) return null

  const pasteFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) return
      setUrl(text)
      if (!nameTouched) setName(deriveName(text))
      setError('')
    } catch {
      setError('Не удалось прочитать буфер обмена (нужен https или localhost и разрешение браузера).')
    }
  }

  const submit = () => {
    const u = url.trim()
    if (!u || loading) return
    setLoading(true)
    setError('')
    axios.post<Project>(API + '/api/projects/clone', { url: u, name: name.trim() || undefined })
      .then(r => { setLoading(false); onAdded(r.data) })
      .catch(e => { setLoading(false); setError(e?.response?.data?.error || String(e)) })
  }

  return (
    <div
      onMouseDown={() => { if (!loading) onClose() }}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-sm"
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="w-[460px] max-w-[90vw] overflow-hidden rounded-xl border border-edge bg-sidebar text-fg shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <span className="text-sm font-semibold">➕ Добавить репозиторий</span>
          <button
            onClick={() => { if (!loading) onClose() }}
            disabled={loading}
            className="ml-auto text-lg leading-none text-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >×</button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1 text-xs text-muted">
            URL репозитория
            <div className="flex gap-2">
              <input
                autoFocus
                value={url}
                onChange={e => { const v = e.target.value; setUrl(v); if (!nameTouched) setName(deriveName(v)) }}
                onKeyDown={e => { if (e.key === 'Enter') submit() }}
                disabled={loading}
                placeholder="https://github.com/user/repo.git"
                className={field + ' flex-1'}
              />
              <button
                type="button"
                onClick={pasteFromClipboard}
                disabled={loading}
                title="Вставить из буфера обмена"
                className="shrink-0 rounded-md border border-edge bg-field px-2.5 text-fg transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
              >📋</button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            <span>Имя проекта <span className="text-dim">(необязательно — по умолчанию из URL)</span></span>
            <input
              value={name}
              onChange={e => { setNameTouched(true); setName(e.target.value) }}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              disabled={loading}
              placeholder="my-project"
              className={field}
            />
          </label>

          {error && (
            <div className="whitespace-pre-wrap rounded-md border border-danger bg-danger/10 px-2.5 py-2 text-xs text-[#f48771]">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2.5 border-t border-edge bg-app px-4 py-3">
          {loading && (
            <span className="flex items-center gap-2 text-xs text-muted">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-accent" />
              Клонирование репозитория…
            </span>
          )}
          <button
            onClick={() => { if (!loading) onClose() }}
            disabled={loading}
            className="ml-auto rounded-md border border-edge px-3.5 py-1.5 text-[13px] text-fg transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >Отмена</button>
          <button
            onClick={submit}
            disabled={loading || !url.trim()}
            className="rounded-md border border-accent bg-accentbg px-4 py-1.5 text-[13px] text-white transition hover:brightness-125 disabled:cursor-not-allowed disabled:border-edge disabled:bg-field disabled:text-muted"
          >Добавить</button>
        </div>
      </div>
    </div>
  )
}
