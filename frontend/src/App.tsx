import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import axios from 'axios'
import clsx from 'clsx'
import AddRepoModal from './AddRepoModal'
import ConfirmModal from './ConfirmModal'
import PromptModal, { PromptConfig } from './PromptModal'
import { agentColors, AGENTS, agentLabel, OVERSEER } from './theme'
import { API, WS_URL } from './config'
import { Project, GitCommit, GitBranches } from './types'
import { userCan, roleLabel, logout, User } from './auth'
import s from './App.module.css'

// Тяжёлые панели — отдельными lazy-чанками (не на старте): чат с агентом и сырой терминал
const ChatPanel = lazy(() => import('./ChatPanel'))
const TerminalPanel = lazy(() => import('./Terminal'))

// uid — стабильный ключ вкладки в рамках сессии; wsId — id серверной сессии (по нему фронт
// переподключается к живому чату/терминалу). Вся вкладка браузера = один воркспейс.
// chat — нативный диалог с агентом (основной интерфейс); agent — legacy claude в PTY
// (переподключение к ранее открытым сессиям); terminal — сырой bash.
type Tab =
  | { uid: number; type: 'chat'; agentType: string; num: number; wsId: string }
  | { uid: number; type: 'agent'; agentType: string; num: number; wsId: string }
  | { uid: number; type: 'terminal'; num: number; wsId: string }

type ServerTerm = { id: string; agent: string | null }
type ServerChat = { id: string; agent: string }

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)

// стабильный ключ вкладки между перезагрузками: сессия — по wsId (терминалы приходят с сервера)
const tabKey = (t: Tab): string => 's:' + t.wsId

function tabLabel(tab: Tab): string {
  if (tab.type === 'chat' || tab.type === 'agent') {
    return tab.agentType === OVERSEER ? '🧭 Общий менеджер' : '🤖 ' + agentLabel(tab.agentType) + ' ' + tab.num
  }
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

export default function App({ workspaceId, user }: { workspaceId: string; user: User }) {
  const isOverseer = workspaceId === OVERSEER
  const persisted = useRef(loadPersisted(workspaceId)).current
  const doLogout = () => logout().then(() => location.reload())

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

    // 2. живые серверные сессии этого воркспейса → вкладки чатов/терминалов (переподключение по wsId)
    Promise.all([
      axios.get<ServerChat[]>(API + '/api/workspaces/' + workspaceId + '/chats'),
      axios.get<ServerTerm[]>(API + '/api/workspaces/' + workspaceId + '/terminals'),
    ]).then(([chatsRes, termsRes]) => {
      const chatTabs: Tab[] = chatsRes.data.map(sc => {
        const num = agentNums.current[sc.agent] = (agentNums.current[sc.agent] || 0) + 1
        return { uid: ++uidCounter.current, type: 'chat', agentType: sc.agent, num, wsId: sc.id }
      })
      const termTabs: Tab[] = termsRes.data.map(st => {
        if (st.agent) {
          const num = agentNums.current[st.agent] = (agentNums.current[st.agent] || 0) + 1
          return { uid: ++uidCounter.current, type: 'agent', agentType: st.agent, num, wsId: st.id }
        }
        const num = termCounter.current = termCounter.current + 1
        return { uid: ++uidCounter.current, type: 'terminal', num, wsId: st.id }
      })
      const restored = [...chatTabs, ...termTabs]
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
      const ex = tabs.find(t => t.type === 'chat' && t.agentType === OVERSEER)
      if (ex) { setActiveUid(ex.uid); return }
    }
    const num = agentNums.current[agentType] = (agentNums.current[agentType] || 0) + 1
    pushTab({ type: 'chat', agentType, num, uid: ++uidCounter.current, wsId: newId() })
  }

  function closeTab(uid: number, e: React.MouseEvent) {
    e.stopPropagation()
    // закрытие вкладки = завершить серверную сессию (гасим сразу, без ожидания GC)
    const tab = tabs.find(t => t.uid === uid)
    if (tab?.type === 'chat') ws.current?.send(JSON.stringify({ type: 'chat_close', chatId: tab.wsId }))
    else if (tab) ws.current?.send(JSON.stringify({ type: 'terminal_close', terminalId: tab.wsId }))
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
      <div className={s.notFound}>
        <div className={s.notFoundMsg}>Проект не найден (возможно, удалён).</div>
        <button onClick={() => location.assign(location.pathname)} className={s.notFoundBtn}>К списку проектов</button>
      </div>
    )
  }

  return (
    <div className={s.app}>
      {/* Верхняя панель */}
      <div className={s.topbar}>
        <span className={s.brand}>AI Workspace IDE</span>
        <button onClick={openLauncher} title="Открыть другой проект в новой вкладке" className={s.launchBtn}>↗</button>
        <span className={s.topRight}>
          {!isOverseer && branches.current && (
            <span className={s.branch} title="Текущая ветка"><span className={s.branchIcon}>⊙</span>{branches.current}</span>
          )}
          <span>{isOverseer ? 'Общий менеджер' : 'Project: ' + wsName}</span>
          <span className={s.userBox} title={'Роль: ' + roleLabel[user.role]}>
            <span className={s.userName}>{user.username}</span>
            <span className={s.roleTag}>{roleLabel[user.role]}</span>
            <button onClick={doLogout} title="Выйти" className={s.logoutBtn}>⎋</button>
          </span>
        </span>
        <button onClick={() => setRightOpen(o => !o)} title="Действия" className={s.menuBtn}>⚙</button>
      </div>

      <div className={s.body}>
        {/* Затемнение под выехавшей панелью (мобилка/планшет) */}
        <div onClick={() => setRightOpen(false)} className={clsx(s.scrim, rightOpen ? s.scrimOpen : s.scrimClosed)} />

        {/* Центр: вкладки + контент */}
        <div className={s.center}>
          <div className={s.tabsBar}>
            {tabs.map(tab => (
              <div key={tab.uid} onClick={() => setActiveUid(tab.uid)} className={clsx(s.tab, activeUid === tab.uid && s.tabActive)}>
                <span>{tabLabel(tab)}</span>
                <span onClick={e => closeTab(tab.uid, e)} className={s.tabClose}>×</span>
              </div>
            ))}
          </div>

          <div className={s.content}>
            {showEmpty && (
              <div className={s.empty}>
                <div className={s.emptyIcon}>{isOverseer ? '🧭' : '🤖'}</div>
                <div>{isOverseer ? 'Открой общего менеджера или терминал справа' : 'Открой агента или терминал кнопками справа'}</div>
              </div>
            )}

            {/* Все вкладки смонтированы постоянно (фон не выгружается) — чаты/агенты/терминалы продолжают работать */}
            {tabs.map(tab => tab.type !== 'chat' ? null : (
              <div key={tab.uid} className={s.pane} style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <Suspense fallback={<div className={s.loading}>Загрузка чата…</div>}>
                  <ChatPanel projectId={workspaceId} agent={tab.agentType} wsId={tab.wsId} perms={user.permissions} active={activeUid === tab.uid} />
                </Suspense>
              </div>
            ))}

            {tabs.map(tab => tab.type !== 'agent' ? null : (
              <div key={tab.uid} className={s.paneTerminal} style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <Suspense fallback={<div className={s.loading}>Загрузка терминала…</div>}>
                  <TerminalPanel projectId={workspaceId} agent={tab.agentType} wsId={tab.wsId} active={activeUid === tab.uid} />
                </Suspense>
              </div>
            ))}

            {tabs.map(tab => tab.type !== 'terminal' ? null : (
              <div key={tab.uid} className={s.paneTerminal} style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <Suspense fallback={<div className={s.loading}>Загрузка терминала…</div>}>
                  <TerminalPanel projectId={workspaceId} wsId={tab.wsId} active={activeUid === tab.uid} />
                </Suspense>
              </div>
            ))}
          </div>
        </div>

        {/* Правая панель: git + действия */}
        <div className={clsx(s.right, rightOpen && s.rightOpen)}>
          <div className={s.rightHeader}>
            <span>ДЕЙСТВИЯ</span>
            <button onClick={() => setRightOpen(false)} title="Закрыть" className={s.closeBtn}>×</button>
          </div>

          {isOverseer ? (
            <>
              <div className={s.sectionHead}>ОБЩИЙ МЕНЕДЖЕР</div>
              <div className={s.btnList}>
                {userCan(user, 'agent.run') && <button onClick={() => openAgent(OVERSEER)} className={s.btnAgent}>🧭 Открыть менеджера</button>}
                {userCan(user, 'project.add') && <button onClick={() => setRepoModalOpen(true)} className={s.btnSecondary}>➕ Добавить репозиторий</button>}
                {userCan(user, 'terminal.open') && <button onClick={openTerminal} className={s.btnSecondary}>⌨ Терминал</button>}
                {!userCan(user, 'agent.run') && !userCan(user, 'terminal.open') && <div className={s.touristNote}>Доступ только на просмотр.</div>}
              </div>
            </>
          ) : (
            <>
              <div className={s.sectionHead}>GIT LOG</div>
              <div className={s.gitLog}>
                {log.length === 0 && <div className={s.gitEmpty}>Нет коммитов</div>}
                {log.slice(0, 10).map(c => (
                  <div key={c.hash} className={s.gitItem}>
                    <div className={s.hash}>{c.hash} <span className={s.commitMsg}>{c.message}</span></div>
                  </div>
                ))}
              </div>

              <div className={s.divider} />
              <div className={s.btnList}>
                {userCan(user, 'agent.run') && AGENTS.map(a => (
                  <button key={a.type} onClick={() => openAgent(a.type)} className={s.btnAgent} style={{ backgroundColor: agentColors[a.type] }}>+ {a.label}</button>
                ))}
                {userCan(user, 'terminal.open') && <button onClick={openTerminal} className={s.btnSecondary}>⌨ Терминал</button>}
                {userCan(user, 'git.commit') && <button onClick={() => setPromptCfg({ title: 'Коммит', label: 'Сообщение коммита', placeholder: 'chore: update', confirmLabel: 'Закоммитить', onSubmit: m => axios.post(API + '/api/projects/' + workspaceId + '/commit', { message: m }).then(() => { axios.get<GitCommit[]>(API + '/api/projects/' + workspaceId + '/log').then(r => setLog(r.data)) }) })} className={s.btnSecondary}>Commit</button>}
                {userCan(user, 'git.push') && <button onClick={() => axios.post(API + '/api/projects/' + workspaceId + '/push')} className={s.btnSecondary}>Push</button>}
                {!userCan(user, 'agent.run') && !userCan(user, 'terminal.open') && <div className={s.touristNote}>Доступ только на просмотр.</div>}
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
