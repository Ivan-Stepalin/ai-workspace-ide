import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import Editor, { loader } from '@monaco-editor/react'
import FileTree, { FileNode } from './FileTree'
import TerminalPanel from './Terminal'
import AddRepoModal from './AddRepoModal'
import ConfirmModal from './ConfirmModal'
import PromptModal, { PromptConfig } from './PromptModal'
import { agentColors, AGENTS, agentLabel, OVERSEER } from './theme'
import { API, WS_URL, BACKEND_HOST } from './config'

loader.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } })

type Project = { id: string; name: string; path: string; created_at: number }
type GitCommit = { hash: string; message: string; date: string }
type GitBranches = { all: string[]; current: string }
type BuildInfo = { running: boolean; port?: number; project: string }
// uid — уникальный id вкладки (стабильный ключ); ownerProject — проект-владелец (null = глобальная, напр. общий менеджер)
type Tab =
  | { uid: number; ownerProject: string | null; type: 'agent'; sessionId: number; agentType: string; num: number }
  | { uid: number; ownerProject: string | null; type: 'file'; name: string; filePath: string; content: string; dirty: boolean }
  | { uid: number; ownerProject: string | null; type: 'terminal'; projectId: string; termId: number }

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
  if (tab.type === 'terminal') return '⌨ Терминал ' + tab.termId
  return (tab.dirty ? '● ' : '') + tab.name
}

// заголовок секции в боковых панелях
const sectionCls = 'px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted'

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [active, setActive] = useState<Project | null>(null)
  const [tree, setTree] = useState<FileNode[]>([])
  const [branches, setBranches] = useState<GitBranches>({ all: [], current: '' })
  const [log, setLog] = useState<GitCommit[]>([])
  const [build, setBuild] = useState<Record<string, BuildInfo>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeUid, setActiveUid] = useState<number | null>(null)
  const [repoModalOpen, setRepoModalOpen] = useState(false)
  const [confirmDeleteProj, setConfirmDeleteProj] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)
  // выезжающие боковые панели на мобилке/планшете (на десктопе всегда видны)
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [promptCfg, setPromptCfg] = useState<PromptConfig | null>(null)  // модалка ввода текста
  const [notice, setNotice] = useState('')                               // модалка-уведомление (ошибки)
  const ws = useRef<WebSocket | null>(null)
  const activeRef = useRef<Project | null>(null)
  const saveRef = useRef<(uid: number) => void>(() => {})
  const uidCounter = useRef(0)
  const sessionCounter = useRef(0)
  const agentNums = useRef<Record<string, number>>({})       // `${projectId}:${agentType}` -> номер
  const termCounters = useRef<Record<string, number>>({})    // projectId -> номер терминала
  const lastActiveByProject = useRef<Record<string, number>>({}) // projectId -> uid последней активной вкладки

  const refreshTree = useCallback((projId?: string) => {
    const id = projId || activeRef.current?.id
    if (!id) return
    axios.get<FileNode[]>(API + '/api/projects/' + id + '/tree').then(r => setTree(r.data))
  }, [])

  useEffect(() => {
    axios.get<Project[]>(API + '/api/projects').then(r => {
      setProjects(r.data)
      if (r.data.length > 0) switchProject(r.data[0])
    })
    const socket = new WebSocket(WS_URL)
    ws.current = socket
    socket.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.type === 'projects_updated') axios.get<Project[]>(API + '/api/projects').then(r => setProjects(r.data))
      if (data.type === 'build_status') setBuild(prev => ({ ...prev, [data.project]: data }))
      if (data.type === 'tree_updated' && data.projectId === activeRef.current?.id) setTree(data.tree)
      if (data.type === 'file_changed') {
        setTabs(prev => {
          const target = prev.find(t => t.type === 'file' && t.filePath === data.filename && t.ownerProject === data.projectId)
          if (target) {
            axios.get<{ content: string }>(API + '/api/projects/' + data.projectId + '/file/' + encodeURIComponent(data.filename))
              .then(r => setTabs(ts => ts.map(t => t.uid === target.uid && t.type === 'file' ? { ...t, content: r.data.content, dirty: false } : t)))
          }
          return prev
        })
      }
    }
  }, [])

  // активировать вкладку (и запомнить как последнюю активную для её проекта)
  function activate(tab: Tab) {
    setActiveUid(tab.uid)
    if (tab.ownerProject) lastActiveByProject.current[tab.ownerProject] = tab.uid
  }

  function pushTab(tab: Tab) {
    setTabs(prev => [...prev, tab])
    setActiveUid(tab.uid)
    if (tab.ownerProject) lastActiveByProject.current[tab.ownerProject] = tab.uid
  }

  // Смена проекта НЕ закрывает вкладки/сессии — они остаются работать в фоне.
  // Просто восстанавливаем видимую активную вкладку выбранного проекта.
  function switchProject(proj: Project) {
    setActive(proj)
    activeRef.current = proj
    const remembered = lastActiveByProject.current[proj.id]
    const hasRemembered = tabs.some(t => t.uid === remembered && t.ownerProject === proj.id)
    const firstOfProj = tabs.find(t => t.ownerProject === proj.id)
    setActiveUid(hasRemembered ? remembered : (firstOfProj ? firstOfProj.uid : null))
    axios.get<FileNode[]>(API + '/api/projects/' + proj.id + '/tree').then(r => setTree(r.data))
    axios.get<GitBranches>(API + '/api/projects/' + proj.id + '/branches').then(r => setBranches(r.data))
    axios.get<GitCommit[]>(API + '/api/projects/' + proj.id + '/log').then(r => setLog(r.data))
  }

  function openFile(filePath: string, name: string) {
    if (!active) return
    setLeftOpen(false)
    const existing = tabs.find(t => t.type === 'file' && t.filePath === filePath && t.ownerProject === active.id)
    if (existing) { activate(existing); return }
    axios.get<{ content: string }>(API + '/api/projects/' + active.id + '/file/' + encodeURIComponent(filePath))
      .then(r => pushTab({ type: 'file', name, filePath, content: r.data.content, dirty: false, uid: ++uidCounter.current, ownerProject: active.id }))
  }

  function openTerminal() {
    if (!active) return
    setRightOpen(false)
    const num = termCounters.current[active.id] = (termCounters.current[active.id] || 0) + 1
    pushTab({ type: 'terminal', projectId: active.id, termId: num, uid: ++uidCounter.current, ownerProject: active.id })
  }

  function openAgent(agentType: string) {
    if (!active) return
    setRightOpen(false)
    const key = active.id + ':' + agentType
    const num = agentNums.current[key] = (agentNums.current[key] || 0) + 1
    pushTab({ type: 'agent', sessionId: ++sessionCounter.current, agentType, num, uid: ++uidCounter.current, ownerProject: active.id })
  }

  // Общий менеджер — единственный, кросс-проектный (ownerProject = null)
  function openOverseer() {
    setRightOpen(false)
    const existing = tabs.find(t => t.type === 'agent' && t.agentType === OVERSEER)
    if (existing) { setActiveUid(existing.uid); return }
    pushTab({ type: 'agent', sessionId: ++sessionCounter.current, agentType: OVERSEER, num: 1, uid: ++uidCounter.current, ownerProject: null })
  }

  function onRepoAdded(proj: Project) {
    setProjects(p => p.some(x => x.id === proj.id) ? p : [...p, proj])
    setRepoModalOpen(false)
    switchProject(proj)
  }

  function deleteProjectConfirmed(proj: Project) {
    setDeleting(true)
    axios.delete(API + '/api/projects/' + proj.id)
      .then(() => {
        setDeleting(false)
        setConfirmDeleteProj(null)
        // убираем вкладки удаляемого проекта (их терминалы/агенты гаснут при размонтировании)
        setTabs(prev => prev.filter(t => t.ownerProject !== proj.id))
        const remaining = projects.filter(p => p.id !== proj.id)
        setProjects(remaining)
        if (active?.id === proj.id) {
          if (remaining.length > 0) switchProject(remaining[0])
          else { setActive(null); activeRef.current = null; setActiveUid(null); setTree([]); setBranches({ all: [], current: '' }); setLog([]) }
        }
      })
      .catch(e => { setDeleting(false); setNotice('Не удалось удалить проект: ' + (e?.response?.data?.error || e)) })
  }

  function saveFile(uid: number) {
    const tab = tabs.find(t => t.uid === uid)
    if (!active || !tab || tab.type !== 'file') return
    axios.post(API + '/api/projects/' + active.id + '/file/' + encodeURIComponent(tab.filePath), { content: tab.content })
      .then(() => {
        setTabs(prev => prev.map(t => t.uid === uid && t.type === 'file' ? { ...t, dirty: false } : t))
        refreshTree()
      })
  }
  saveRef.current = saveFile

  function closeTab(uid: number, e: React.MouseEvent) {
    e.stopPropagation()
    setTabs(prev => prev.filter(t => t.uid !== uid))
    if (activeUid === uid) {
      const rest = tabs.filter(t => t.uid !== uid && (t.ownerProject === null || t.ownerProject === active?.id))
      setActiveUid(rest.length ? rest[rest.length - 1].uid : null)
    }
  }

  function addProject() {
    setPromptCfg({
      title: 'Новый проект', label: 'Название проекта', placeholder: 'my-project', confirmLabel: 'Создать',
      onSubmit: name => axios.post<Project>(API + '/api/projects', { name }).then(r => { setProjects(p => [...p, r.data]); switchProject(r.data) }),
    })
  }

  const buildInfo = active ? build[active.id] : null
  // вкладки, видимые в баре текущего проекта (+ глобальные, напр. общий менеджер)
  const visibleTabs = tabs.filter(t => t.ownerProject === null || t.ownerProject === active?.id)
  const activeTab = tabs.find(t => t.uid === activeUid)
  const activeFilePath = activeTab?.type === 'file' ? activeTab.filePath : null
  const showEmpty = !visibleTabs.some(t => t.uid === activeUid)

  const actionBtn = (label: string, fn: () => void, color?: string) => (
    <button
      key={label}
      onClick={fn}
      style={color ? { color } : undefined}
      className="flex w-full items-center rounded-lg border border-edge px-3.5 py-2.5 text-left text-sm text-fg transition-colors hover:bg-white/5 active:bg-white/10"
    >{label}</button>
  )

  return (
    <div className="flex h-screen flex-col bg-app text-[13px] text-fg">
      {/* Верхняя панель: проекты */}
      <div className="flex h-11 flex-shrink-0 items-center gap-1 border-b border-edge bg-topbar px-2">
        <button onClick={() => { setRightOpen(false); setLeftOpen(o => !o) }} title="Проводник" className="rounded-md px-2 py-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/5 hover:text-fg lg:hidden">☰</button>
        <span className="mr-1 hidden text-[11px] text-muted sm:inline">ПРОЕКТЫ</span>
        <div className="flex items-center gap-1 overflow-x-auto">
          {projects.map(p => (
            <div
              key={p.id}
              onClick={() => switchProject(p)}
              className={
                'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1.5 pl-3 pr-2 text-sm transition-colors ' +
                (active?.id === p.id ? 'bg-accentbg text-white' : 'text-muted hover:bg-white/5')
              }
            >
              <span>{p.name}</span>
              <span
                onClick={e => { e.stopPropagation(); setConfirmDeleteProj(p) }}
                title="Удалить проект"
                className="rounded px-1 text-base leading-none opacity-60 transition hover:bg-white/15 hover:opacity-100"
              >×</span>
            </div>
          ))}
          <button onClick={addProject} title="Новый проект" className="px-2 text-xl leading-none text-muted transition-colors hover:text-fg">+</button>
        </div>
        <span className="ml-auto hidden font-mono text-[11px] text-dim md:inline">{BACKEND_HOST}</span>
        <button onClick={() => { setLeftOpen(false); setRightOpen(o => !o) }} title="Действия" className="ml-1 rounded-md px-2 py-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/5 hover:text-fg lg:hidden">⚙</button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Затемнение под выехавшей панелью (мобилка/планшет) — плавное появление */}
        <div
          onClick={() => { setLeftOpen(false); setRightOpen(false) }}
          className={
            'fixed inset-x-0 bottom-0 top-11 z-30 bg-black/50 transition-opacity duration-200 lg:hidden ' +
            ((leftOpen || rightOpen) ? 'opacity-100' : 'pointer-events-none opacity-0')
          }
        />

        {/* Левая панель: проводник + ветки */}
        <div className={
          'fixed bottom-0 left-0 top-11 z-40 flex w-[86vw] max-w-[340px] flex-col border-r border-edge bg-sidebar transition-transform duration-200 ' +
          'lg:static lg:top-auto lg:z-auto lg:w-[240px] lg:max-w-none lg:translate-x-0 lg:shadow-none ' +
          (leftOpen ? 'translate-x-0 shadow-2xl shadow-black/50' : '-translate-x-full')
        }>
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-muted">
            <span className="truncate">ПРОВОДНИК {active && <span className="font-normal text-dim">— {active.name}</span>}</span>
            <button onClick={() => setLeftOpen(false)} title="Закрыть" className="ml-auto rounded px-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/10 hover:text-fg lg:hidden">×</button>
          </div>
          <div className="flex flex-1 flex-col overflow-hidden">
            <FileTree tree={tree} activeFile={activeFilePath} onOpen={openFile} onRefresh={() => refreshTree()} projectId={active?.id || ''} api={API} />
          </div>
          <div className="flex-shrink-0 border-t border-edge py-1.5">
            <div className="mb-1 px-3 text-[11px] text-dim">ВЕТКИ</div>
            {branches.all.map(b => (
              <div key={b} className={'flex items-center gap-1.5 px-4 py-0.5 text-xs ' + (b === branches.current ? 'text-mint' : 'text-muted')}>
                <span className="text-[9px]">{b === branches.current ? '●' : '○'}</span>{b}
              </div>
            ))}
          </div>
        </div>

        {/* Центр: вкладки + контент */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex h-10 flex-shrink-0 items-end overflow-x-auto border-b border-edge bg-sidebar">
            {visibleTabs.map(tab => (
              <div
                key={tab.uid}
                onClick={() => activate(tab)}
                className={
                  'flex h-10 flex-shrink-0 cursor-pointer select-none items-center gap-2 border-r border-t-2 border-edge px-4 text-[13px] transition-colors ' +
                  (activeUid === tab.uid ? 'border-t-accent bg-app text-fg' : 'border-t-transparent text-muted hover:bg-white/5')
                }
              >
                <span>{tabLabel(tab)}</span>
                <span onClick={e => closeTab(tab.uid, e)} className="rounded px-1 text-lg leading-none text-dim transition-colors hover:bg-white/10 hover:text-fg">×</span>
              </div>
            ))}
          </div>

          <div className="relative flex-1 overflow-hidden">
            {/* Пустое состояние — нет активной видимой вкладки */}
            {showEmpty && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-dim">
                <div className="text-[28px]">🤖</div>
                <div className="text-sm">{active ? 'Открой агента кнопками справа или файл слева' : 'Создай или выбери проект'}</div>
              </div>
            )}

            {/* Все вкладки всегда смонтированы (фон не выгружается); видна только активная.
                Благодаря этому агент/терминал продолжают работать при переключении проектов. */}
            {/* Агенты = интерактивный claude в PTY-терминале (виден весь процесс) */}
            {tabs.map(tab => tab.type !== 'agent' ? null : (
              <div key={tab.uid} className="absolute inset-0 bg-app" style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <TerminalPanel
                  projectId={tab.ownerProject || ''}
                  agent={tab.agentType}
                  onFileSystemChange={() => {
                    if (tab.ownerProject) refreshTree(tab.ownerProject)
                    else axios.get<Project[]>(API + '/api/projects').then(r => setProjects(r.data))
                  }}
                />
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
                </div>
              </div>
            ))}

            {tabs.map(tab => tab.type !== 'terminal' ? null : (
              <div key={tab.uid} className="absolute inset-0 bg-app" style={{ display: activeUid === tab.uid ? 'block' : 'none' }}>
                <TerminalPanel projectId={tab.projectId} onFileSystemChange={() => refreshTree(tab.projectId)} />
              </div>
            ))}
          </div>
        </div>

        {/* Правая панель: git, сервер, действия.
            [&>*]:shrink-0 — чтобы при скролле на мобилке блоки (напр. список коммитов) не схлопывались. */}
        <div className={
          'fixed bottom-0 right-0 top-11 z-40 flex w-[86vw] max-w-[340px] flex-col overflow-y-auto border-l border-edge bg-sidebar transition-transform duration-200 [&>*]:shrink-0 ' +
          'lg:static lg:top-auto lg:z-auto lg:w-[240px] lg:max-w-none lg:translate-x-0 lg:overflow-visible lg:shadow-none ' +
          (rightOpen ? 'translate-x-0 shadow-2xl shadow-black/50' : 'translate-x-full')
        }>
          <div className="flex items-center justify-between border-b border-edge px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-muted lg:hidden">
            <span>ДЕЙСТВИЯ</span>
            <button onClick={() => setRightOpen(false)} title="Закрыть" className="rounded px-1.5 text-lg leading-none text-muted transition-colors hover:bg-white/10 hover:text-fg">×</button>
          </div>
          <div className={sectionCls + ' border-b border-edge'}>SOURCE CONTROL</div>
          <div className="max-h-[180px] overflow-y-auto p-2">
            {log.length === 0 && <div className="px-1 py-0.5 text-xs text-dim">Нет коммитов</div>}
            {log.slice(0, 10).map(c => (
              <div key={c.hash} className="flex gap-1.5 px-1 py-0.5 text-[11px]">
                <span className="flex-shrink-0 font-mono text-accent">{c.hash}</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">{c.message}</span>
              </div>
            ))}
          </div>

          <div className={sectionCls + ' border-y border-edge'}>СЕРВЕР</div>
          <div className="flex items-center gap-2 px-3 py-2">
            <span className={'inline-block h-2 w-2 rounded-full ' + (buildInfo?.running ? 'bg-mint' : 'bg-dim')} />
            <span className={'text-xs ' + (buildInfo?.running ? 'text-mint' : 'text-dim')}>{buildInfo?.running ? ':' + buildInfo.port + ' запущен' : 'остановлен'}</span>
          </div>

          <div className={sectionCls + ' border-t border-edge'}>ГЛОБАЛЬНО</div>
          <div className="flex flex-col gap-2 p-3">
            {actionBtn('🧭 Общий менеджер', openOverseer, agentColors.overseer)}
            {actionBtn('➕ Добавить репозиторий', () => setRepoModalOpen(true))}
          </div>

          <div className={sectionCls + ' border-t border-edge'}>ДЕЙСТВИЯ {active && <span className="font-normal text-dim">— {active.name}</span>}</div>
          <div className="flex flex-col gap-2 p-3">
            {AGENTS.map(a => actionBtn('🤖 ' + a.label, () => openAgent(a.type), agentColors[a.type]))}
            {actionBtn('⌨ Терминал', openTerminal)}
            {buildInfo?.running && actionBtn('🌐 Открыть :' + buildInfo.port, () => window.open('http://' + BACKEND_HOST + ':' + buildInfo!.port, '_blank'), '#4ec9b0')}
            {actionBtn('Коммит', () => { if (!active) return; const proj = active; setPromptCfg({ title: 'Коммит', label: 'Сообщение коммита', placeholder: 'chore: update', confirmLabel: 'Закоммитить', onSubmit: m => axios.post(API + '/api/projects/' + proj.id + '/commit', { message: m }).then(() => { switchProject(proj); refreshTree() }) }) })}
            {actionBtn('Push', () => active && axios.post(API + '/api/projects/' + active.id + '/push'))}
            {actionBtn('Старт :8080', () => active && axios.post(API + '/api/projects/' + active.id + '/build/start', { port: 8080 }))}
            {actionBtn('Стоп', () => active && axios.post(API + '/api/projects/' + active.id + '/build/stop'))}
          </div>

          <div className="mt-auto flex items-center bg-accent px-3 py-[3px]">
            <span className="text-[11px] text-white">● {branches.current || 'main'}</span>
            <span className="ml-auto text-[11px] text-white/70">ai-workspace</span>
          </div>
        </div>
      </div>

      <AddRepoModal open={repoModalOpen} onClose={() => setRepoModalOpen(false)} onAdded={onRepoAdded} />
      <ConfirmModal
        open={!!confirmDeleteProj}
        title="Удалить проект"
        message={confirmDeleteProj ? `Удалить проект «${confirmDeleteProj.name}»?\n\nПапка ${confirmDeleteProj.path} будет удалена безвозвратно.` : ''}
        confirmLabel="Удалить"
        danger
        loading={deleting}
        onConfirm={() => confirmDeleteProj && deleteProjectConfirmed(confirmDeleteProj)}
        onClose={() => { if (!deleting) setConfirmDeleteProj(null) }}
      />
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
