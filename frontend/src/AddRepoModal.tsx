import { useState, useEffect } from 'react'
import axios from 'axios'
import clsx from 'clsx'
import { API } from './config'
import { Project } from './types'
import s from './modal.module.css'

interface Props {
  open: boolean
  onClose: () => void
  onAdded: (p: Project) => void
}

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
    <div onMouseDown={() => { if (!loading) onClose() }} className={s.overlay}>
      <div onMouseDown={e => e.stopPropagation()} className={s.panel} style={{ width: 460 }}>
        <div className={s.header}>
          <span>➕ Добавить репозиторий</span>
          <button onClick={() => { if (!loading) onClose() }} disabled={loading} className={s.closeX}>×</button>
        </div>

        <div className={s.body}>
          <div className={s.fields}>
            <label className={s.label}>
              URL репозитория
              <div className={s.row}>
                <input
                  autoFocus
                  value={url}
                  onChange={e => { const v = e.target.value; setUrl(v); if (!nameTouched) setName(deriveName(v)) }}
                  onKeyDown={e => { if (e.key === 'Enter') submit() }}
                  disabled={loading}
                  placeholder="https://github.com/user/repo.git"
                  className={clsx(s.field, s.flex1)}
                />
                <button type="button" onClick={pasteFromClipboard} disabled={loading} title="Вставить из буфера обмена" className={s.pasteBtn}>📋</button>
              </div>
            </label>
            <label className={s.label}>
              <span>Имя проекта <span className={s.dim}>(необязательно — по умолчанию из URL)</span></span>
              <input
                value={name}
                onChange={e => { setNameTouched(true); setName(e.target.value) }}
                onKeyDown={e => { if (e.key === 'Enter') submit() }}
                disabled={loading}
                placeholder="my-project"
                className={s.field}
              />
            </label>

            {error && <div className={s.error}>{error}</div>}
          </div>
        </div>

        <div className={s.footer}>
          {loading && (
            <span className={s.spinnerWrap}>
              <span className={s.spinner} />
              Клонирование репозитория…
            </span>
          )}
          <button onClick={() => { if (!loading) onClose() }} disabled={loading} className={clsx(s.btn, s['ml-auto'])}>Отмена</button>
          <button onClick={submit} disabled={loading || !url.trim()} className={clsx(s.btn, s.btnPrimary)}>Добавить</button>
        </div>
      </div>
    </div>
  )
}
