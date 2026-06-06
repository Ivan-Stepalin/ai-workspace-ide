import { useState, useEffect, useCallback } from 'react'
import clsx from 'clsx'
import {
  listUsers, createUser, updateUser, deleteUser,
  roleLabel, ROLES, ACTIONS, defaultPermissions,
  Role, Action, User,
} from './auth'
import s from './modal.module.css'
import u from './UsersAdmin.module.css'

interface Props {
  open: boolean
  onClose: () => void
  me: User              // текущий сисадмин — себя удалить нельзя
}

type Sel = User | 'new' | null

// Страница управления пользователями (только для роли с user.manage). Таблица слева,
// при клике по строке открывается сайдпанель с профилем, ролью и чекбоксами прав.
export default function UsersAdmin({ open, onClose, me }: Props) {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<Sel>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // поля сайдпанели
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('tourist')
  const [perms, setPerms] = useState<Action[]>([])

  const refresh = useCallback(() => {
    setLoading(true)
    listUsers().then(setUsers).catch(e => setError(e?.response?.data?.error || String(e))).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!open) return
    setSel(null); setError('')
    refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) (sel ? setSel(null) : onClose()) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, sel, onClose])

  // заполнить поля при выборе строки / создании
  useEffect(() => {
    setError('')
    if (sel === 'new') {
      setUsername(''); setPassword(''); setFirstName(''); setLastName(''); setEmail('')
      setRole('tourist'); setPerms(defaultPermissions.tourist)
    } else if (sel) {
      setUsername(sel.username); setPassword(''); setFirstName(sel.firstName); setLastName(sel.lastName)
      setEmail(sel.email); setRole(sel.role); setPerms(sel.permissions)
    }
  }, [sel])

  if (!open) return null

  const toggle = (a: Action) => setPerms(p => p.includes(a) ? p.filter(x => x !== a) : [...p, a])
  const pickRole = (r: Role) => { setRole(r); setPerms(defaultPermissions[r]) }   // смена роли подставляет дефолтные права

  const save = () => {
    if (busy) return
    setBusy(true); setError('')
    const done = () => { setBusy(false); setSel(null); refresh() }
    const fail = (e: unknown) => { setBusy(false); setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || String(e)) }
    if (sel === 'new') {
      if (!username.trim() || !password) { setBusy(false); setError('Логин и пароль обязательны'); return }
      createUser({ username: username.trim(), password, role, firstName, lastName, email, permissions: perms }).then(done).catch(fail)
    } else if (sel) {
      updateUser(sel.id, { role, firstName, lastName, email, permissions: perms, ...(password ? { password } : {}) }).then(done).catch(fail)
    }
  }

  const remove = () => {
    if (!sel || sel === 'new' || sel.id === me.id || busy) return
    setBusy(true); setError('')
    deleteUser(sel.id).then(() => { setBusy(false); setSel(null); refresh() })
      .catch(e => { setBusy(false); setError(e?.response?.data?.error || String(e)) })
  }

  const fullName = (usr: User) => [usr.firstName, usr.lastName].filter(Boolean).join(' ')
  const isSelf = sel && sel !== 'new' && sel.id === me.id

  return (
    <div onMouseDown={() => { if (!busy) onClose() }} className={s.overlay}>
      <div onMouseDown={e => e.stopPropagation()} className={u.panel}>
        <div className={s.header}>
          <span>👤 Пользователи</span>
          <button onClick={() => setSel('new')} className={clsx(s.btn, s.btnPrimary, u.addBtn)}>＋ Новый</button>
          <button onClick={onClose} className={s.closeX}>×</button>
        </div>

        <div className={u.content}>
          {/* Таблица */}
          <div className={u.tableWrap}>
            {loading ? <div className={u.muted}>Загрузка…</div> : (
              <table className={u.table}>
                <thead>
                  <tr><th>Имя</th><th>Фамилия</th><th>Почта</th><th>Роль</th></tr>
                </thead>
                <tbody>
                  {users.length === 0 && <tr><td colSpan={4} className={u.muted}>Пользователей нет</td></tr>}
                  {users.map(usr => (
                    <tr
                      key={usr.id}
                      onClick={() => setSel(usr)}
                      className={clsx(u.row, sel !== 'new' && sel?.id === usr.id && u.rowActive)}
                    >
                      <td>{usr.firstName || <span className={u.dim}>—</span>} <span className={u.login}>@{usr.username}</span></td>
                      <td>{usr.lastName || <span className={u.dim}>—</span>}</td>
                      <td>{usr.email || <span className={u.dim}>—</span>}</td>
                      <td><span className={u.roleTag}>{roleLabel[usr.role]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Сайдпанель пользователя */}
          {sel && (
            <div className={u.side}>
              <div className={u.sideHead}>
                <span>{sel === 'new' ? 'Новый пользователь' : fullName(sel) || sel.username}</span>
                <button onClick={() => setSel(null)} className={s.closeX}>×</button>
              </div>

              <div className={u.sideBody}>
                {sel === 'new' ? (
                  <div className={u.field2}>
                    <label className={u.lbl}>Логин<input className={s.field} value={username} onChange={e => setUsername(e.target.value)} placeholder="login" /></label>
                    <label className={u.lbl}>Пароль<input className={s.field} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="пароль" /></label>
                  </div>
                ) : (
                  <div className={u.field2}>
                    <label className={u.lbl}>Логин<input className={s.field} value={username} disabled /></label>
                    <label className={u.lbl}>Новый пароль<input className={s.field} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="не менять" /></label>
                  </div>
                )}

                <div className={u.field2}>
                  <label className={u.lbl}>Имя<input className={s.field} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Имя" /></label>
                  <label className={u.lbl}>Фамилия<input className={s.field} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Фамилия" /></label>
                </div>
                <label className={u.lbl}>Почта<input className={s.field} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" /></label>

                <label className={u.lbl}>Роль (шаблон прав + поведение агента)
                  <select className={s.field} value={role} onChange={e => pickRole(e.target.value as Role)}>
                    {ROLES.map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}
                  </select>
                </label>

                <div className={u.permsTitle}>Доступный функционал</div>
                <div className={u.perms}>
                  {ACTIONS.map(({ action, label }) => {
                    const lockSelf = isSelf && action === 'user.manage'   // себе нельзя снять управление юзерами
                    return (
                      <label key={action} className={clsx(u.perm, lockSelf && u.permLocked)}>
                        <input type="checkbox" checked={perms.includes(action)} disabled={!!lockSelf} onChange={() => toggle(action)} />
                        <span>{label}</span>
                      </label>
                    )
                  })}
                </div>

                {error && <div className={s.error}>{error}</div>}
              </div>

              <div className={u.sideFoot}>
                {sel !== 'new' && (
                  <button onClick={remove} disabled={busy || sel.id === me.id} title={sel.id === me.id ? 'Нельзя удалить себя' : 'Удалить'} className={clsx(s.btn, s.btnDanger)}>Удалить</button>
                )}
                <button onClick={save} disabled={busy} className={clsx(s.btn, s.btnPrimary, s['ml-auto'])}>{busy ? '…' : 'Сохранить'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
