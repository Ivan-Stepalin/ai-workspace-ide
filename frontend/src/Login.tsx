import { useState } from 'react'
import { login, User } from './auth'
import s from './Login.module.css'

// Форма входа. Показывается, когда нет активной сессии (GET /me вернул 401).
export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !username.trim() || !password) return
    setBusy(true); setErr('')
    try { onLogin(await login(username.trim(), password)) }
    catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setErr(msg || 'Не удалось войти')
      setBusy(false)
    }
  }

  return (
    <div className={s.screen}>
      <form onSubmit={submit} className={s.card}>
        <div className={s.brand}>
          <span className={s.brandIcon}>🤖</span>
          <h1 className={s.brandTitle}>AI Workspace</h1>
        </div>

        <label className={s.label}>Логин</label>
        <input autoFocus value={username} onChange={e => setUsername(e.target.value)} className={s.input} />

        <label className={s.label}>Пароль</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={s.input} />

        {err && <div className={s.error}>{err}</div>}

        <button type="submit" disabled={busy || !username.trim() || !password} className={s.submit}>{busy ? 'Вход…' : 'Войти'}</button>
      </form>
    </div>
  )
}
