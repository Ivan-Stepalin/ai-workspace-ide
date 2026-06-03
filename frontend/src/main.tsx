import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ProjectPicker from './ProjectPicker.tsx'

// Роутинг точки входа: ?p=<projectId|overseer> → воркспейс (App), иначе → лаунчер выбора проекта.
// Так каждая вкладка браузера работает ровно с одним проектом, без условных хуков внутри App.
const workspaceId = new URLSearchParams(location.search).get('p')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {workspaceId ? <App workspaceId={workspaceId} /> : <ProjectPicker />}
  </StrictMode>,
)
