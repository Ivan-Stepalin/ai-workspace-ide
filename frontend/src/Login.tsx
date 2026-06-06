import { useState } from 'react'
import { login, User } from './auth'

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
    <div className="flex min-h-screen items-center justify-center bg-app px-4 text-fg">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-edge bg-sidebar p-6 shadow-2xl shadow-black/40">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="text-2xl">🤖</span>
          <h1 className="text-lg font-semibold">AI Workspace</h1>
        </div>

        <label className="mb-1 block text-[12px] text-muted">Логин</label>
        <input
          autoFocus value={username} onChange={e => setUsername(e.target.value)}
          className="mb-3 w-full rounded-lg border border-edge bg-field px-3 py-2 text-[13px] text-fg outline-none transition focus:border-accent"
        />

        <label className="mb-1 block text-[12px] text-muted">Пароль</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-edge bg-field px-3 py-2 text-[13px] text-fg outline-none transition focus:border-accent"
        />

        {err && <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</div>}

        <button
          type="submit" disabled={busy || !username.trim() || !password}
          className="w-full rounded-lg bg-accent px-4 py-2 text-[13px] text-white transition hover:brightness-110 disabled:opacity-50"
        >{busy ? 'Вход…' : 'Войти'}</button>
      </form>
    </div>
  )
}
