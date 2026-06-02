import { useState, useEffect } from 'react'
import axios from 'axios'
import { C } from './theme'
import { API } from './config'
import { Project } from './types'

interface Props {
  open: boolean
  onClose: () => void
  onAdded: (p: Project) => void
}

export default function AddRepoModal({ open, onClose, onAdded }: Props) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // сброс полей при каждом открытии
  useEffect(() => {
    if (open) { setUrl(''); setName(''); setError(''); setLoading(false) }
  }, [open])

  // Esc закрывает (кроме момента загрузки)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading, onClose])

  if (!open) return null

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
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <style>{`@keyframes awspin{to{transform:rotate(360deg)}}`}</style>
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 460, maxWidth: '90vw', background: C.sidebar, border: '1px solid ' + C.border, borderRadius: 6, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', color: C.text, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid ' + C.border }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>➕ Добавить репозиторий</span>
          <button onClick={() => { if (!loading) onClose() }} disabled={loading} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.textMuted, fontSize: 18, lineHeight: 1, cursor: loading ? 'not-allowed' : 'pointer' }}>×</button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: C.textMuted }}>
            URL репозитория
            <input
              autoFocus
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              disabled={loading}
              placeholder="https://github.com/user/repo.git"
              style={{ padding: '8px 10px', borderRadius: 4, border: '1px solid ' + C.border, fontSize: 13, background: C.inputBg, color: C.text, outline: 'none' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: C.textMuted }}>
            Имя проекта <span style={{ color: C.textDim }}>(необязательно — по умолчанию из URL)</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              disabled={loading}
              placeholder="my-project"
              style={{ padding: '8px 10px', borderRadius: 4, border: '1px solid ' + C.border, fontSize: 13, background: C.inputBg, color: C.text, outline: 'none' }}
            />
          </label>

          {error && (
            <div style={{ padding: '8px 10px', borderRadius: 4, fontSize: 12, background: 'rgba(244,71,71,0.12)', border: '1px solid #f44747', color: '#f48771', whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid ' + C.border, background: C.panel }}>
          {loading && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textMuted }}>
              <span style={{ width: 14, height: 14, border: '2px solid ' + C.border, borderTopColor: C.accent, borderRadius: '50%', display: 'inline-block', animation: 'awspin 0.7s linear infinite' }} />
              Клонирование репозитория…
            </span>
          )}
          <button onClick={() => { if (!loading) onClose() }} disabled={loading} style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 4, border: '1px solid ' + C.border, background: 'transparent', color: C.text, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13 }}>Отмена</button>
          <button onClick={submit} disabled={loading || !url.trim()} style={{ padding: '6px 16px', borderRadius: 4, border: '1px solid ' + C.accent, background: (loading || !url.trim()) ? C.inputBg : C.accentBg, color: (loading || !url.trim()) ? C.textMuted : '#fff', cursor: (loading || !url.trim()) ? 'not-allowed' : 'pointer', fontSize: 13 }}>Добавить</button>
        </div>
      </div>
    </div>
  )
}
