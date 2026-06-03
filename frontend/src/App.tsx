import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import axios from 'axios'
import FileTree, { FileNode } from './FileTree'
import AddRepoModal from './AddRepoModal'
import ConfirmModal from './ConfirmModal'
import PromptModal, { PromptConfig } from './PromptModal'
import { agentColors, AGENTS, agentLabel, OVERSEER } from './theme'
import { API, WS_URL, BACKEND_HOST } from './config'
import { Project, GitCommit, GitBranches } from './types'

// Тяжёлые панели — отдельными lazy-чанками (не на старте): редактор при открытии файла, терминал при открытии сессии
const Editor = lazy(() => import('./EditorLazy'))
const TerminalPanel = lazy(() => import('./Terminal'))

// uid — стабильный ключ вкладки в рамках сессии; wsId — id серверной PTY-сессии (по нему фронт
// переподключается к живому терминалу/агенту). В новой модели вся вкладка браузера = один воркспейс.
type Tab =
  | { uid: number; type: 'agent'; agentType: string; num: number; wsId: string }
  | { uid: number; type: 'file'; name: string; filePath: string; content: string; dirty: boolean }
  | { uid: number; type: 'terminal'; num: number; wsId: string }

type ServerTerm = { id: string; agent: string | null }

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)

// стабильный ключ вкладки между перезагрузками: файл — по пути, сессия — по wsId (терминалы приходят с сервера)
const tabKey = (t: Tab): string => t.type === 'file' ? 'f:' + t.filePath : 's:' + t.wsId

function getLang(filename: string): string {
  const ext = filename.split('.').pop() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', html: 'html', css: 'css', md: 'markdown', py: 'python',
    sh: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
  }
  return map[ext] || 'plaintext'
}

function tabLabel(tab: Tab): string {
  if (tab.type === 'agent') return tab.agentType === OVERSEER ? '🧭 Общий менеджер' : '🤖 ' + agentLabel(tab.agentType) + ' ' + tab.num
  if (tab.type === 'terminal') return '⌨ Терминал ' + tab.num
  return (tab.dirty ? '● ' : '') + tab.name
}

const sectionCls = 'px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted'

// Файловые вкладки персистятся в localStorage пер-воркспейс (терминалы — с сервера, источник истины).
type Persisted = { files: { filePath: string; name: string }[]; activeKey: string | null }
const lsKey = (wid: string) => 'aiws.ws.' + wid
function loadPersisted(wid: string): Persisted {
  try { const raw = localStorage.getItem(lsKey(wid)); if (raw) return JSON.parse(raw) as Persisted } catch { /* ignore */ }
  return { files: [], activeKey: null }
}

// открыть лаунчер выбора проекта в НОВОЙ вкладке браузера
const openLauncher = () => window.open(location.pathname, '_blank')

export default function App({ workspaceId }: { workspaceId: string }) {
  const isOverseer = workspaceId === OVERSEER
  const persisted = useRef(loadPersisted(workspaceId)).current

  const [wsName, setWsName] = useState(isOverseer ? 'Общий менеджер' : '…')
  const [notFound, setNotFound] = useState(false)
  const [tree, setTree] = useState<FileNode[]>([])
  const [branches, setBranches] = useState<GitBranches>({ all: [], current: '' })
  const [log, setLog] = useState<GitCommit[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeUid, setActiveUid] = useState<number | null>(null)
  const [repoModalOpen, setRepoModalOpen] = useState(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null)
  const [notice, setNotice] = useState('')

  const ws = useRef<WebSocket | null>(null)
  const saveRef = useRef<(uid: number) => void>(() => {})
  const uidCounter = useRef(0)
  const termCounter = useRef(0)
  const agentNums = useRef<Record<string, number>>({})

  const refreshTree = useCallback(() => {
    if (isOverseer) return
    axios.get<FileNode[]>(API + '/api/projects/' + workspaceId + '/tree').then(r => setTree(r.data))
  }, [isOverseer, workspaceId])

  // openFile пересоздаётся каждый рендер (замыкает tabs) — стабильную обёртку через ref отдаём в memo(FileTree)
  const openFileRef = useRef<(filePath: string, name: string) => void>(() => {})
  const openFileStable = useCallback((filePath: string, name: string) => openFileRef.current(filePath, name), [])

  // ── Инициализация воркспейса: имя/дерево/git + переподключение ко всем живым серверным сессиям ──
  useEffect(() => {
    // 1. метаданные проекта — все 4 запроса параллельно (было 4 последовательных)
    if (!isOverseer) {
      Promise.all([
        axios.get<Project[]>(API + '/api/projects'),
        axios.get<FileNode[]>(API + '/api/projects/' + workspaceId + '/tree'),
        axios.get<GitBranches>(API + '/api/projects/' + workspaceId + '/branches'),
        axios.get<GitCommit[]>(API + '/api/projects/' + workspaceId + '/log'),
      ]).then(([projectsRes, treeRes, branchesRes, logRes]) => {
        const p = projectsRes.data.find(x => x.id === workspaceId)
        if (!p) { setNotFound(true); return }
        setWsName(p.name)
        setTree(treeRes.data)
        setBranches(branchesRes.data)
        setLog(logRes.data)
      })
    }

    // 2. живые серверные сессии этого воркспейса → вкладки агентов/терминалов (переподключение по wsId)
    axios.get<ServerTerm[]>(API + '/api/workspaces/' + workspaceId + '/terminals').then(async r => {
      const restored: Tab[] = r.data.map(st => {
        if (st.agent) {
          const num = agentNums.current[st.agent] = (agentNums.current[st.agent] || 0) + 1
          return { uid: ++uidCounter.current, type: 'agent', agentType: st.agent, num, wsId: st.id }
        }
        const num = termCounter.current = termCounter.current + 1
        return { uid: ++uidCounter.current, type: 'terminal', num, wsId: st.id }
      })

      // 3. файловые вкладки из localStorage — контент всех файлов грузим параллельно
      const fileTabs: Tab[] = persisted.files.map(f => ({ uid: ++uidCounter.current, type: 'file', name: f.name, filePath: f.filePath, content: '', dirty: false }))

      const all = [...restored, ...fileTabs]
      setTabs(all)
      const act = all.find(t => tabKey(t) === persisted.activeKey) || all[0]
      setActiveUid(act ? act.uid : null)

      // Параллельная загрузка контента всех файловых вкладок
      const fileLoads = await Promise.all(
        fileTabs.filter(f => f.type === 'file').map(f =>
          axios.get<{ content: string }>(API + '/api/projects/' + workspaceId + '/file/' + encodeURIComponent(f.filePath))
            .then(c => ({ uid: f.uid, content: c.data.content, ok: true }))
            .catch(() => ({ uid: f.uid, content: '', ok: false }))
        )
      )
      const missingUids = new Set(fileLoads.filter(fl => !fl.ok).map(fl => fl.uid))
      setTabs(ts =>
        ts
          .filter(x => !missingUids.has(x.uid))
          .map(x => {
            const loaded = fileLoads.find(fl => fl.uid === x.uid && fl.ok)
            return (loaded && x.type === 'file') ? { ...x, content: loaded.content, dirty: false } : x
          })
      )
    })

    // 4. главный WS — подписка на бродкасты воркспейса + отправка terminal_close
    const socket = new WebSocket(WS_URL)
    ws.current = socket
    socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', workspaceId }))
    socket.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.type === 'tree_updated' && data.projectId === workspaceId) setTree(data.tree)
      if (data.type === 'file_changed' && data.projectId === workspaceId) {
        setTabs(prev => {
          const target = prev.find(t => t.type === 'file' && t.filePath === data.filename)
          if (target) {
            axios.get<{ content: string }>(API + '/api/projects/' + workspaceId + '/file/' + encodeURIComponent(data.filename))
              .then(r => setTabs(ts => ts.map(t => t.uid === target.uid && t.type === 'file' ? { ...t, content: r.data.content, dirty: false } : t)))
          }
          return prev
        })
      }
    }
    return () => socket.close()
  }, [workspaceId, isOverseer, persisted])

  // персист: только файловые вкладки + активный ключ (терминалы восстанавливаются с сервера)
  useEffect(() => {
    const files = tabs.filter(t => t.type === 'file').map(t => t.type === 'file' ? { filePath: t.filePath, name: t.name } : null).filter(Boolean) as { filePath: string; name: string }[]
    const activeTab = tabs.find(t => t.uid === activeUid)
    const data: Persisted = { files, activeKey: activeTab ? tabKey(activeTab) : null }
    try { localStorage.setItem(lsKey(workspaceId), JSON.stringify(data)) } catch { /* ignore */ }
  }, [tabs, activeUid, workspaceId])

  function pushTab(tab: Tab) {
    setTabs(prev => [...prev, tab])
    setActiveUid(tab.uid)
  }

  function openFile(filePath: string, name: string) {
    setLeftOpen(false)
    const existing = tabs.find(t => t.type === 'file' && t.filePath === filePath)
    if (existing) { setActiveUid(existing.uid); return }
    axios.get<{ content: string }>(API + '/api/projects/' + workspaceId + '/file/' + encodeURIComponent(filePath))
      .then(r => pushTab({ type: 'file', name, filePath, content: r.data.content, dirty: false, uid: ++uidCounter.current }))
  }
  openFileRef.current = openFile

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

  function saveFile(uid: number) {
    const tab = tabs.find(t => t.uid === uid)
    if (!tab || tab.type !== 'file') return
    axios.post(API + '/api/projects/' + workspaceId + '/file/' + encodeURIComponent(tab.filePath), { content: tab.content })
      .then(() => {
        setTabs(prev => prev.map(t => t.uid === uid && t.type === 'file' ? { ...t, dirty: false } : t))
        refreshTree()
      })
  }
  saveRef.current = saveFile

  function closeTab(uid: number, e: React.MouseEvent) {
    e.stopPropagation()
    // закрытие вкладки = завершить серверную сессию (PTY гасим сразу, без ожидания GC)
    const tab = tabs.find(t => t.uid === uid)
    if (tab && (tab.type === 'agent' || tab.type === 'terminal')) {
      ws.current?.send(JSON.stringify({ type: 'terminal_close', terminalId: tab.wsId }))
    }
    setTabs(prev => prev.filter(t => t.uid !== uid))
    if (activeUid === uid) {
      const rest = tabs.filter(t => t.uid !== uid)
      setActiveUid(rest.length ? rest[rest.length - 1].uid : null)
    }
  }

  const activeTab = useMemo(() => tabs.find(t => t.uid === activeUid), [tabs, activeUid])
  const activeFilePath = activeTab?.type === 'file' ? activeTab.filePath : null
  const showEmpty = !activeTab

  const actionBtn = (label: string, fn: () => void, color?: string) => (
    <button
      key={label}
      onClick={fn}
      style={color ? { color } : undefined}
      className="flex w-full items-center rounded-lg border border-edge px-3.5 py-2.5 text-left text-sm text-fg transition-colors hover:bg-white/5 active:bg-white/10"
    >{label}</button>
  )

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
        <button onClick={() => { setRightOpen(false); setLeftOpen(o => !o) }} title="Проводник" className="mr-2 rounded px-1.5 py-1 text-base leading-none text-muted transition-colors hover:text-fg lg:hidden">☰</button>
        <span className="text-[15px] font-semibold tracking-tight" style={{ color: '#4fc3f7' }}>AI Workspace IDE</span>
        <button onClick={openLauncher} title="Открыть другой проект в новой вкладке" className="ml-3 rounded border border-edge px-2 py-0.5 text-xs text-muted transition-colors hover:bg-white/5 hover:text-fg">↗</button>
        <span className="ml-auto text-[13px] text-muted">{isOverseer ? 'Общий менеджер' : 'Project: ' + wsName}</span>
        <button onClick={() => { setLeftOpen(false); setRightOpen(o => !o) }} title="Действия" className="ml-3 rounded px-1.5 py-1 text-base leading-none text-muted transition-colors hover:text-fg lg:hidden">⚙</button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Затемнение под выехавшей панелью (мобилка/планшет) */}
        <div
          onClick={() => { setLeftOpen(false); setRightOpen(false) }}
          className={
            'fixed inset-x-0 bottom-0 top-11 z-30 bg-black/50 transition-opacity duration-200 lg:hidden ' +
            ((leftOpen || rightOpen) ? 'opacity-100' : 'pointer-events-none opacity-0')
          }
        />

        {/* Левая панель: проводник + ветки (только для проектов) */}
        {!isOverseer && (
          <div className={
            'fixed bottom-0 left-0 top-11 z-40 flex w-[86vw] max-w-[340px] flex-col border-r border-edge bg-sidebar transition-transform duration-200 ' +
            'lg:static lg:top-auto lg:z-auto lg:w-[240px] lg:max-w-none lg:translate-x-0 lg:shadow-none ' +
            (leftOpen ? 'translate-x-0 shadow-2xl shadow-black/50' : '-translate-x-full')
          }>
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
              <span className="text-[11px] font-bold tracking-[0.1em]" style={{ color: '#4fc3f7' }}>FILES</span>
              <button onClick={() => setLeftOpen(false)} title="Закрыть" className="ml-auto rounded px-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/10 hover:text-fg lg:hidden">×</button>
            </div>
            <div className="flex flex-1 flex-col overflow-hidden">
              <FileTree tree={tree} activeFile={activeFilePath} onOpen={openFileStable} onRefresh={refreshTree} projectId={workspaceId} api={API} />
            </div>
            <div className="flex-shrink-0 border-t border-edge py-2">
              <div className="mb-1.5 px-3 text-[10px] font-bold tracking-[0.1em] text-muted">BRANCHES</div>
              {branches.all.map(b => (
                <div key={b} className={'flex items-center gap-1.5 px-4 py-0.5 text-[12px] ' + (b === branches.current ? 'font-medium' : 'text-muted')} style={b === branches.current ? { color: '#4fc3f7' } : undefined}>
                  <span className="text-[9px]">{b === branches.current ? '⊙' : '○'}</span>{b}
                </div>
              ))}
            </div>
          </div>
        )}

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
                <div className="text-sm">{isOverseer ? 'Открой общего менеджера или терминал справа' : 'Открой агента кнопками справа или файл слева'}</div>
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
                    onFileSystemChange={refreshTree}
                  />
                </Suspense>
              </div>
            ))}

            {tabs.map(tab => tab.type !== 'file' ? null : (
              <div key={tab.uid} className="absolute inset-0 flex-col" style={{ display: activeUid === tab.uid ? 'flex' : 'none' }}>
                <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge bg-sidebar px-3 py-1">
                  <span className="font-mono text-xs text-muted">{tab.filePath}</span>
                  <span className="text-[11px] text-dim">— {getLang(tab.name)}</span>
                  {tab.dirty && <span className="text-[11px] text-gold">● несохранено</span>}
                  <button onClick={() => saveFile(tab.uid)} className="ml-auto rounded-md border border-accent bg-accentbg px-3 py-[3px] text-xs text-white transition hover:brightness-125">Сохранить (Ctrl+S)</button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <Suspense fallback={<div className="flex h-full items-center justify-center text-dim">Загрузка редактора…</div>}>
                  <Editor
                    height="100%"
                    theme="vs-dark"
                    language={getLang(tab.name)}
                    value={tab.content}
                    onChange={val => setTabs(prev => prev.map(t => t.uid === tab.uid && t.type === 'file' ? { ...t, content: val ?? '', dirty: true } : t))}
                    onMount={(editor, monaco) => {
                      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current(tab.uid))
                      editor.focus()
                      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
                        target: monaco.languages.typescript.ScriptTarget.ES2020,
                        allowNonTsExtensions: true,
                        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
                        module: monaco.languages.typescript.ModuleKind.CommonJS,
                        noEmit: true, esModuleInterop: true,
                        jsx: monaco.languages.typescript.JsxEmit.React, allowJs: true,
                      })
                    }}
                    options={{
                      fontSize: 14, lineHeight: 22,
                      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
                      fontLigatures: true, minimap: { enabled: true },
                      scrollBeyondLastLine: false, wordWrap: 'on',
                      formatOnPaste: true, formatOnType: true, tabSize: 2,
                      smoothScrolling: true, cursorBlinking: 'smooth',
                      cursorSmoothCaretAnimation: 'on',
                      bracketPairColorization: { enabled: true },
                      guides: { bracketPairs: true },
                      suggest: { showKeywords: true, showSnippets: true },
                      quickSuggestions: { other: true, comments: true, strings: true },
                      parameterHints: { enabled: true },
                      hover: { enabled: true },
                    }}
                  />
                  </Suspense>
                </div>
              </div>
            ))}

            {tabs.map(tab => tab.type !== 'terminal' ? null : (
              <div key={tab.uid} className="absolute inset-0 bg-terminal" style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-dim">Загрузка терминала…</div>}>
                  <TerminalPanel projectId={workspaceId} wsId={tab.wsId} onFileSystemChange={refreshTree} />
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
                <button onClick={() => setPromptCfg({ title: 'Коммит', label: 'Сообщение коммита', placeholder: 'chore: update', confirmLabel: 'Закоммитить', onSubmit: m => axios.post(API + '/api/projects/' + workspaceId + '/commit', { message: m }).then(() => { refreshTree(); axios.get<GitCommit[]>(API + '/api/projects/' + workspaceId + '/log').then(r => setLog(r.data)) }) })} className="w-full rounded-md bg-btnbg px-3 py-2 text-left text-[13px] text-fg transition hover:bg-white/10">Commit</button>
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
