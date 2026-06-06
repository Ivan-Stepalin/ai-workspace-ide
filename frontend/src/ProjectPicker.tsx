import { useState, useEffect } from 'react'
import axios from 'axios'
import AddRepoModal from './AddRepoModal'
import ConfirmModal from './ConfirmModal'
import { API } from './config'
import { agentColors } from './theme'
import { can, roleLabel, logout, User } from './auth'
import s from './ProjectPicker.module.css'

type Project = { id: string; name: string; path: string; created_at: number }

// Переход в воркспейс = полная перезагрузка с ?p=<id> (чистая инициализация App под один проект).
function openWorkspace(id: string, newTab = false): void {
  const url = location.pathname + '?p=' + encodeURIComponent(id)
  if (newTab) window.open(url, '_blank')
  else location.assign(url)
}

// Лаунчер: выбор проекта / создание нового / общий менеджер. Показывается, когда в URL нет ?p=.
// Каждый проект открывается в своей вкладке браузера (этот экран — точка входа новой вкладки).
export default function ProjectPicker({ user }: { user: User }) {
  const doLogout = () => logout().then(() => location.reload())
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    axios.get<Project[]>(API + '/api/projects')
      .then(r => setProjects(r.data))
      .finally(() => setLoading(false))
  }, [])

  function confirmDelete() {
    const p = toDelete
    if (!p) return
    setDeleting(true)
    axios.delete(API + '/api/projects/' + p.id)
      .then(() => { setProjects(ps => ps.filter(x => x.id !== p.id)); setToDelete(null) })
      .finally(() => setDeleting(false))
  }

  function createProject() {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    axios.post<Project>(API + '/api/projects', { name: n })
      .then(r => openWorkspace(r.data.id))
      .catch(() => setBusy(false))
  }

  return (
    <div className={s.screen}>
      <div className={s.wrap}>
        <div className={s.head}>
          <span className={s.headIcon}>🤖</span>
          <h1 className={s.title}>AI Workspace</h1>
          <span className={s.user} title={'Роль: ' + roleLabel[user.role]}>
            <span className={s.userName}>{user.username}</span>
            <span className={s.roleTag}>{roleLabel[user.role]}</span>
            <button onClick={doLogout} title="Выйти" className={s.logout}>Выйти</button>
          </span>
        </div>
        <p className={s.subtitle}>Выбери проект — он откроется в этой вкладке. Другой проект открывай в новой вкладке.</p>

        {/* Общий менеджер — кросс-проектный воркспейс */}
        <button onClick={() => openWorkspace('overseer')} className={s.overseer}>
          <span className={s.overseerIcon} style={{ color: agentColors.overseer }}>🧭</span>
          <div>
            <div className={s.overseerTitle}>Общий менеджер</div>
            <div className={s.overseerSub}>Видит все проекты, клонирует репозитории, рекомендует агентов</div>
          </div>
        </button>

        <div className={s.sectionRow}>
          <span className={s.sectionLabel}>ПРОЕКТЫ</span>
          {can(user.role, 'project.add') && (
            <div className={s.actions}>
              <button onClick={() => setRepoOpen(true)} className={s.btnGhost}>➕ Репозиторий</button>
              <button onClick={() => { setCreating(c => !c); setName('') }} className={s.btnAccent}>+ Новый проект</button>
            </div>
          )}
        </div>

        {creating && (
          <div className={s.createRow}>
            <input
              autoFocus value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createProject(); if (e.key === 'Escape') setCreating(false) }}
              placeholder="название проекта"
              className={s.createInput}
            />
            <button onClick={createProject} disabled={!name.trim() || busy} className={s.createBtn}>{busy ? '…' : 'Создать'}</button>
          </div>
        )}

        <div className={s.grid}>
          {loading && <div className={s.empty}>Загрузка…</div>}
          {!loading && projects.length === 0 && <div className={s.empty}>Пока нет проектов — создай новый или добавь репозиторий</div>}
          {projects.map(p => (
            <div key={p.id} onClick={() => openWorkspace(p.id)} className={s.card}>
              <span className={s.cardName}>{p.name}</span>
              <span className={s.cardPath}>{p.path}</span>
              {can(user.role, 'project.delete') && (
                <span onClick={e => { e.stopPropagation(); setToDelete(p) }} title="Удалить проект" className={s.del}>×</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <AddRepoModal open={repoOpen} onClose={() => setRepoOpen(false)} onAdded={proj => openWorkspace(proj.id)} />
      <ConfirmModal
        open={!!toDelete}
        title="Удалить проект"
        message={toDelete ? `Удалить проект «${toDelete.name}»?\n\nПапка ${toDelete.path} будет удалена безвозвратно.` : ''}
        confirmLabel="Удалить"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => { if (!deleting) setToDelete(null) }}
      />
    </div>
  )
}
