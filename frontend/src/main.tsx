import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import axios from 'axios'
import './index.css'
import App from './App.tsx'
import ProjectPicker from './ProjectPicker.tsx'
import Login from './Login.tsx'
import { fetchMe, User } from './auth'

// Cookie-сессия: axios должен слать cookie и при кросс-origin (VITE_BACKEND_HOST).
axios.defaults.withCredentials = true

// Роутинг точки входа: ?p=<projectId|overseer> → воркспейс (App), иначе → лаунчер выбора проекта.
const workspaceId = new URLSearchParams(location.search).get('p')

// Гейт авторизации: пока проверяем /me — заглушка; нет сессии → Login; есть → App/ProjectPicker.
function Root() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchMe().then(u => { setUser(u); setLoading(false) }) }, [])

  if (loading) return <div className="flex h-screen items-center justify-center bg-app text-sm text-dim">Загрузка…</div>
  if (!user) return <Login onLogin={setUser} />
  return workspaceId ? <App workspaceId={workspaceId} user={user} /> : <ProjectPicker user={user} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
