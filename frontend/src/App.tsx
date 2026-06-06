import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import axios from 'axios'
import AddRepoModal from './AddRepoModal'
import ConfirmModal from './ConfirmModal'
import PromptModal, { PromptConfig } from './PromptModal'
import { agentColors, AGENTS, agentLabel, OVERSEER } from './theme'
import { API, WS_URL } from './config'
import { Project, GitCommit, GitBranches } from './types'

// Тяжёлая панель — отдельным lazy-чанком (не на старте): терминал при открытии сессии
const TerminalPanel = lazy(() => import('./Terminal'))

// uid — стабильный ключ вкладки в рамках сессии; wsId — id серверной PTY-сессии (по нему фронт
// переподключается к живому терминалу/агенту). Вся вкладка браузера = один воркспейс.
type Tab =
  | { uid: number; type: 'agent'; agentType: string; num: number; wsId: string }
  | { uid: number; type: 'terminal'; num: number; wsId: string }

type ServerTerm = { id: string; agent: string | null }

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)

// стабильный ключ вкладки между перезагрузками: сессия — по wsId (терминалы приходят с сервера)
const tabKey = (t: Tab): string => 's:' + t.wsId

function tabLabel(tab: Tab): string {
  if (tab.type === 'agent') return tab.agentType === OVERSEER ? '🧭 Общий менеджер' : '🤖 ' + agentLabel(tab.agentType) + ' ' + tab.num
  return '⌨ Терминал ' + tab.num
}

// Персистим только активную вкладку пер-воркспейс (сами терминалы — с сервера, источник истины).
type Persisted = { activeKey: string | null }
const lsKey = (wid: string) => 'aiws.ws.' + wid
function loadPersisted(wid: string): Persisted {
  try { const raw = localStorage.getItem(lsKey(wid)); if (raw) return JSON.parse(raw) as Persisted } catch { /* ignore */ }
  return { activeKey: null }
}

// открыть лаунчер выбора проекта в НОВОЙ вкладке браузера
const openLauncher = () => window.open(location.pathname, '_blank')

export default function App({ workspaceId }: { workspaceId: string }) {
  const isOverseer = workspaceId === OVERSEER
  const persisted = useRef(loadPersisted(workspaceId)).current

  const [wsName, setWsName] = useState(isOverseer ? 'Общий менеджер' : '…')
  const [notFound, setNotFound] = useState(false)
  const [branches, setBranches] = useState<GitBranches>({ all: [], current: '' })
  const [log, setLog] = useState<GitCommit[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeUid, setActiveUid] = useState<number | null>(null)
  const [repoModalOpen, setRepoModalOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null)
  const [notice, setNotice] = useState('')

  const ws = useRef<WebSocket | null>(null)
  const uidCounter = useRef(0)
  const termCounter = useRef(0)
  const agentNums = useRef<Record<string, number>>({})

  // ── Инициализация воркспейса: имя/git + переподключение ко всем живым серверным сессиям ──
  useEffect(() => {
    // 1. метаданные проекта — все запросы параллельно
    if (!isOverseer) {
      Promise.all([
        axios.get<Project[]>(API + '/api/projects'),
        axios.get<GitBranches>(API + '/api/projects/' + workspaceId + '/branches'),
        axios.get<GitCommit[]>(API + '/api/projects/' + workspaceId + '/log'),
      ]).then(([projectsRes, branchesRes, logRes]) => {
        const p = projectsRes.data.find(x => x.id === workspaceId)
        if (!p) { setNotFound(true); return }
        setWsName(p.name)
        setBranches(branchesRes.data)
        setLog(logRes.data)
      })
    }

    // 2. живые серверные сессии этого воркспейса → вкладки агентов/терминалов (переподключение по wsId)
    axios.get<ServerTerm[]>(API + '/api/workspaces/' + workspaceId + '/terminals').then(r => {
      const restored: Tab[] = r.data.map(st => {
        if (st.agent) {
          const num = agentNums.current[st.agent] = (agentNums.current[st.agent] || 0) + 1
          return { uid: ++uidCounter.current, type: 'agent', agentType: st.agent, num, wsId: st.id }
        }
        const num = termCounter.current = termCounter.current + 1
        return { uid: ++uidCounter.current, type: 'terminal', num, wsId: st.id }
      })
      setTabs(restored)
      const act = restored.find(t => tabKey(t) === persisted.activeKey) || restored[0]
      setActiveUid(act ? act.uid : null)
    })

    // 3. главный WS — подписка на бродкасты воркспейса + отправка terminal_close
    const socket = new WebSocket(WS_URL)
    ws.current = socket
    socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', workspaceId }))
    return () => socket.close()
  }, [workspaceId, isOverseer, persisted])

  // персист: только активная вкладка (терминалы восстанавливаются с сервера)
  useEffect(() => {
    const activeTab = tabs.find(t => t.uid === activeUid)
    const data: Persisted = { activeKey: activeTab ? tabKey(activeTab) : null }
    try { localStorage.setItem(lsKey(workspaceId), JSON.stringify(data)) } catch { /* ignore */ }
  }, [tabs, activeUid, workspaceId])

  function pushTab(tab: Tab) {
    setTabs(prev => [...prev, tab])
    setActiveUid(tab.uid)
  }

  function openTerminal() {
    setRightOpen(false)
    const num = termCounter.current = termCounter.current + 1
    pushTab({ type: 'terminal', num, uid: ++uidCounter.current, wsId: newId() })
  }

  function openAgent(agentType: string) {
    setRightOpen(false)
    // общий менеджер — один на воркспейс: если уже открыт, просто активируем
    if (agentType === OVERSEER) {
      const ex = tabs.find(t => t.type === 'agent' && t.agentType === OVERSEER)
      if (ex) { setActiveUid(ex.uid); return }
    }
    const num = agentNums.current[agentType] = (agentNums.current[agentType] || 0) + 1
    pushTab({ type: 'agent', agentType, num, uid: ++uidCounter.current, wsId: newId() })
  }

  function closeTab(uid: number, e: React.MouseEvent) {
    e.stopPropagation()
    // закрытие вкладки = завершить серверную сессию (PTY гасим сразу, без ожидания GC)
    const tab = tabs.find(t => t.uid === uid)
    if (tab) ws.current?.send(JSON.stringify({ type: 'terminal_close', terminalId: tab.wsId }))
    setTabs(prev => prev.filter(t => t.uid !== uid))
    if (activeUid === uid) {
      const rest = tabs.filter(t => t.uid !== uid)
      setActiveUid(rest.length ? rest[rest.length - 1].uid : null)
    }
  }

  const activeTab = useMemo(() => tabs.find(t => t.uid === activeUid), [tabs, activeUid])
  const showEmpty = !activeTab

  if (notFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-app text-fg">
        <div className="text-sm text-muted">Проект не найден (возможно, удалён).</div>
        <button onClick={() => location.assign(location.pathname)} className="rounded-md border border-accent bg-accentbg px-4 py-2 text-sm text-white transition hover:brightness-125">К списку проектов</button>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-app text-[13px] text-fg">
      {/* Верхняя панель */}
      <div className="flex h-11 flex-shrink-0 items-center border-b border-edge bg-topbar px-4">
        <span className="text-[15px] font-semibold tracking-tight" style={{ color: '#4fc3f7' }}>AI Workspace IDE</span>
        <button onClick={openLauncher} title="Открыть другой проект в новой вкладке" className="ml-3 rounded border border-edge px-2 py-0.5 text-xs text-muted transition-colors hover:bg-white/5 hover:text-fg">↗</button>
        <span className="ml-auto flex items-center gap-2 text-[13px] text-muted">
          {!isOverseer && branches.current && (
            <span className="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[12px]" style={{ color: '#4fc3f7' }} title="Текущая ветка">
              <span className="text-[9px]">⊙</span>{branches.current}
            </span>
          )}
          <span>{isOverseer ? 'Общий менеджер' : 'Project: ' + wsName}</span>
        </span>
        <button onClick={() => setRightOpen(o => !o)} title="Действия" className="ml-3 rounded px-1.5 py-1 text-base leading-none text-muted transition-colors hover:text-fg lg:hidden">⚙</button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Затемнение под выехавшей панелью (мобилка/планшет) */}
        <div
          onClick={() => setRightOpen(false)}
          className={
            'fixed inset-x-0 bottom-0 top-11 z-30 bg-black/50 transition-opacity duration-200 lg:hidden ' +
            (rightOpen ? 'opacity-100' : 'pointer-events-none opacity-0')
          }
        />

        {/* Центр: вкладки + контент */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex h-11 flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-edge bg-sidebar px-2">
            {tabs.map(tab => (
              <div
                key={tab.uid}
                onClick={() => setActiveUid(tab.uid)}
                className={
                  'flex h-7 flex-shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-3 text-[13px] transition-colors ' +
                  (activeUid === tab.uid ? 'bg-accent text-white' : 'text-muted hover:bg-white/5 hover:text-fg')
                }
              >
                <span>{tabLabel(tab)}</span>
                <span onClick={e => closeTab(tab.uid, e)} className="ml-0.5 text-base leading-none opacity-50 transition-opacity hover:opacity-100">×</span>
              </div>
            ))}
          </div>

          <div className="relative flex-1 overflow-hidden">
            {showEmpty && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-dim">
                <div className="text-[28px]">{isOverseer ? '🧭' : '🤖'}</div>
                <div className="text-sm">{isOverseer ? 'Открой общего менеджера или терминал справа' : 'Открой агента или терминал кнопками справа'}</div>
              </div>
            )}

            {/* Все вкладки смонтированы постоянно (фон не выгружается) — агенты/терминалы продолжают работать */}
            {tabs.map(tab => tab.type !== 'agent' ? null : (
              <div key={tab.uid} className="absolute inset-0 bg-terminal" style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-dim">Загрузка терминала…</div>}>
                  <TerminalPanel
                    projectId={workspaceId}
                    agent={tab.agentType}
                    wsId={tab.wsId}
                    active={activeUid === tab.uid}
                  />
                </Suspense>
              </div>
            ))}

            {tabs.map(tab => tab.type !== 'terminal' ? null : (
              <div key={tab.uid} className="absolute inset-0 bg-terminal" style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-dim">Загрузка терминала…</div>}>
                  <TerminalPanel projectId={workspaceId} wsId={tab.wsId} active={activeUid === tab.uid} />
                </Suspense>
              </div>
            ))}
          </div>
        </div>

        {/* Правая панель: git + действия */}
        <div className={
          'fixed bottom-0 right-0 top-11 z-40 flex w-[86vw] max-w-[340px] flex-col overflow-y-auto border-l border-edge bg-sidebar transition-transform duration-200 [&>*]:shrink-0 ' +
          'lg:static lg:top-auto lg:z-auto lg:w-[240px] lg:max-w-none lg:translate-x-0 lg:overflow-visible lg:shadow-none ' +
          (rightOpen ? 'translate-x-0 shadow-2xl shadow-black/50' : 'translate-x-full')
        }>
          <div className="flex items-center justify-between border-b border-edge px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-muted lg:hidden">
            <span>ДЕЙСТВИЯ</span>
            <button onClick={() => setRightOpen(false)} title="Закрыть" className="rounded px-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/10 hover:text-fg">×</button>
          </div>

          {isOverseer ? (
            <>
              <div className="border-b border-edge px-3 py-2 text-[10px] font-bold tracking-[0.1em] text-muted">ОБЩИЙ МЕНЕДЖЕР</div>
              <div className="flex flex-col gap-1.5 p-3">
                <button onClick={() => openAgent(OVERSEER)} className="w-full rounded-md bg-accent px-3 py-2 text-left text-[13px] text-white transition hover:brightness-110">🧭 Открыть менеджера</button>
                <button onClick={() => setRepoModalOpen(true)} className="w-full rounded-md bg-btnbg px-3 py-2 text-left text-[13px] text-fg transition hover:bg-white/10">➕ Добавить репозиторий</button>
                <button onClick={openTerminal} className="w-full rounded-md bg-btnbg px-3 py-2 text-left text-[13px] text-fg transition hover:bg-white/10">⌨ Терминал</button>
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-edge px-3 py-2 text-[10px] font-bold tracking-[0.1em] text-muted">GIT LOG</div>
              <div className="max-h-[200px] overflow-y-auto px-3 py-2">
                {log.length === 0 && <div className="py-1 text-xs text-dim">Нет коммитов</div>}
                {log.slice(0, 10).map(c => (
                  <div key={c.hash} className="py-1">
                    <div className="font-mono text-[12px] font-semibold text-fg">{c.hash} <span className="font-normal text-muted">{c.message}</span></div>
                  </div>
                ))}
              </div>

              <div className="border-t border-edge" />
              <div className="flex flex-col gap-1.5 p-3">
                {AGENTS.map(a => (
                  <button key={a.type} onClick={() => openAgent(a.type)} className="w-full rounded-md bg-accent px-3 py-2 text-left text-[13px] text-white transition hover:brightness-110" style={{ backgroundColor: agentColors[a.type] }}>
                    + {a.label}
                  </button>
                ))}
                <button onClick={openTerminal} className="w-full rounded-md bg-btnbg px-3 py-2 text-left text-[13px] text-fg transition hover:bg-white/10">⌨ Терминал</button>
                <button onClick={() => setPromptCfg({ title: 'Коммит', label: 'Сообщение коммита', placeholder: 'chore: update', confirmLabel: 'Закоммитить', onSubmit: m => axios.post(API + '/api/projects/' + workspaceId + '/commit', { message: m }).then(() => { axios.get<GitCommit[]>(API + '/api/projects/' + workspaceId + '/log').then(r => setLog(r.data)) }) })} className="w-full rounded-md bg-btnbg px-3 py-2 text-left text-[13px] text-fg transition hover:bg-white/10">Commit</button>
                <button onClick={() => axios.post(API + '/api/projects/' + workspaceId + '/push')} className="w-full rounded-md bg-btnbg px-3 py-2 text-left text-[13px] text-fg transition hover:bg-white/10">Push</button>
              </div>
            </>
          )}
        </div>
      </div>

      <AddRepoModal open={repoModalOpen} onClose={() => setRepoModalOpen(false)} onAdded={proj => { setRepoModalOpen(false); window.open(location.pathname + '?p=' + encodeURIComponent(proj.id), '_blank') }} />
      <PromptModal config={promptCfg} onClose={() => setPromptCfg(null)} />
      <ConfirmModal
        open={!!notice}
        title="Ошибка"
        message={notice}
        confirmLabel="OK"
        hideCancel
        onConfirm={() => setNotice('')}
        onClose={() => setNotice('')}
      />
    </div>
  )
}
