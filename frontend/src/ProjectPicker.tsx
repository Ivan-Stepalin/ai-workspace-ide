import { useState, useEffect } from 'react'
import axios from 'axios'
import AddRepoModal from './AddRepoModal'
import ConfirmModal from './ConfirmModal'
import { API } from './config'
import { agentColors } from './theme'

type Project = { id: string; name: string; path: string; created_at: number }

// Переход в воркспейс = полная перезагрузка с ?p=<id> (чистая инициализация App под один проект).
function openWorkspace(id: string, newTab = false): void {
  const url = location.pathname + '?p=' + encodeURIComponent(id)
  if (newTab) window.open(url, '_blank')
  else location.assign(url)
}

// Лаунчер: выбор проекта / создание нового / общий менеджер. Показывается, когда в URL нет ?p=.
// Каждый проект открывается в своей вкладке браузера (этот экран — точка входа новой вкладки).
export default function ProjectPicker() {
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-app px-4 py-10 text-fg">
      <div className="w-full max-w-2xl">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="text-2xl">🤖</span>
          <h1 className="text-xl font-semibold">AI Workspace</h1>
        </div>
        <p className="mb-6 text-sm text-muted">Выбери проект — он откроется в этой вкладке. Другой проект открывай в новой вкладке.</p>

        {/* Общий менеджер — кросс-проектный воркспейс */}
        <button
          onClick={() => openWorkspace('overseer')}
          className="mb-5 flex w-full items-center gap-3 rounded-xl border border-edge bg-sidebar px-4 py-3 text-left transition hover:bg-white/5"
        >
          <span className="text-xl" style={{ color: agentColors.overseer }}>🧭</span>
          <div>
            <div className="text-sm font-medium">Общий менеджер</div>
            <div className="text-xs text-muted">Видит все проекты, клонирует репозитории, рекомендует агентов</div>
          </div>
        </button>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted">ПРОЕКТЫ</span>
          <div className="flex gap-2">
            <button onClick={() => setRepoOpen(true)} className="rounded-md border border-edge px-2.5 py-1 text-xs text-muted transition hover:bg-white/5 hover:text-fg">➕ Репозиторий</button>
            <button onClick={() => { setCreating(c => !c); setName('') }} className="rounded-md border border-accent bg-accentbg px-2.5 py-1 text-xs text-white transition hover:brightness-125">+ Новый проект</button>
          </div>
        </div>

        {creating && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-edge bg-sidebar p-2">
            <input
              autoFocus value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createProject(); if (e.key === 'Escape') setCreating(false) }}
              placeholder="название проекта"
              className="flex-1 rounded-md border border-edge bg-field px-2.5 py-1.5 text-[13px] text-fg outline-none transition focus:border-accent"
            />
            <button onClick={createProject} disabled={!name.trim() || busy} className="rounded-md border border-accent bg-accentbg px-3 py-1.5 text-xs text-white transition hover:brightness-125 disabled:opacity-50">{busy ? '…' : 'Создать'}</button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {loading && <div className="col-span-full py-6 text-center text-sm text-dim">Загрузка…</div>}
          {!loading && projects.length === 0 && <div className="col-span-full py-6 text-center text-sm text-dim">Пока нет проектов — создай новый или добавь репозиторий</div>}
          {projects.map(p => (
            <div
              key={p.id}
              onClick={() => openWorkspace(p.id)}
              className="group relative flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-edge bg-sidebar px-4 py-3 text-left transition hover:border-accent hover:bg-white/5"
            >
              <span className="pr-6 text-sm font-medium">{p.name}</span>
              <span className="w-full truncate text-[11px] text-dim">{p.path}</span>
              <span
                onClick={e => { e.stopPropagation(); setToDelete(p) }}
                title="Удалить проект"
                className="absolute right-2 top-2 rounded px-1.5 text-base leading-none text-dim opacity-0 transition hover:bg-white/10 hover:text-fg group-hover:opacity-100"
              >×</span>
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
