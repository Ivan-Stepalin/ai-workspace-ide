import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import Editor, { loader } from '@monaco-editor/react'
import FileTree, { FileNode } from './FileTree'
import TerminalPanel from './Terminal'
import AgentSession from './AgentSession'
import { C, agentColors, AGENTS, agentLabel, Message } from './theme'
import { API, WS_URL, BACKEND_HOST } from './config'

loader.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } })

type Project = { id: string; name: string; path: string; created_at: number }
type GitCommit = { hash: string; message: string; date: string }
type GitBranches = { all: string[]; current: string }
type BuildInfo = { running: boolean; port?: number; project: string }
type Tab =
  | { type: 'agent'; sessionId: number; agentType: string; num: number }
  | { type: 'file'; name: string; filePath: string; content: string; dirty: boolean }
  | { type: 'terminal'; projectId: string; termId: number }

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
  if (tab.type === 'agent') return '🤖 ' + agentLabel(tab.agentType) + ' ' + tab.num
  if (tab.type === 'terminal') return '⌨ Терминал ' + tab.termId
  return (tab.dirty ? '● ' : '') + tab.name
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [active, setActive] = useState<Project | null>(null)
  // всё, что относится к сессиям агентов, индексируется по sessionId
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const [agentStatus, setAgentStatus] = useState<Record<string, string>>({})
  const [streaming, setStreaming] = useState<Record<string, boolean>>({})
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [tree, setTree] = useState<FileNode[]>([])
  const [branches, setBranches] = useState<GitBranches>({ all: [], current: '' })
  const [log, setLog] = useState<GitCommit[]>([])
  const [build, setBuild] = useState<Record<string, BuildInfo>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState(0)
  const ws = useRef<WebSocket | null>(null)
  const activeRef = useRef<Project | null>(null)
  const saveRef = useRef<(i: number) => void>(() => {})
  const termCounter = useRef(0)
  const sessionCounter = useRef(0)
  const agentNums = useRef<Record<string, number>>({})

  const refreshTree = useCallback((projId?: string) => {
    const id = projId || activeRef.current?.id
    if (!id) return
    axios.get<FileNode[]>(API + '/api/projects/' + id + '/tree').then(r => setTree(r.data))
  }, [])

  useEffect(() => {
    document.body.style.background = C.bg
    document.body.style.margin = '0'
    axios.get<Project[]>(API + '/api/projects').then(r => {
      setProjects(r.data)
      if (r.data.length > 0) switchProject(r.data[0])
    })
    const socket = new WebSocket(WS_URL)
    ws.current = socket
    socket.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.type === 'agent_status') {
        const sid = String(data.sessionId)
        setAgentStatus(prev => ({ ...prev, [sid]: data.status }))
        if (data.status === 'done' || data.status === 'error')
          setTimeout(() => setAgentStatus(prev => { const n = { ...prev }; delete n[sid]; return n }), 2000)
      }
      if (data.type === 'chunk_start') setStreaming(prev => ({ ...prev, [String(data.sessionId)]: true }))
      if (data.type === 'chunk') {
        setMessages(prev => {
          const k = String(data.sessionId)
          const msgs = prev[k] || []
          const last = msgs[msgs.length - 1]
          if (last?.streaming) return { ...prev, [k]: [...msgs.slice(0, -1), { ...last, text: last.text + data.text }] }
          return { ...prev, [k]: [...msgs, { role: 'agent' as const, agent: data.agent, text: data.text, streaming: true }] }
        })
      }
      if (data.type === 'chunk_end') {
        const k = String(data.sessionId)
        setStreaming(prev => ({ ...prev, [k]: false }))
        setMessages(prev => ({ ...prev, [k]: (prev[k] || []).map(m => ({ ...m, streaming: false })) }))
      }
      if (data.type === 'build_status') setBuild(prev => ({ ...prev, [data.project]: data }))
      if (data.type === 'tree_updated' && data.projectId === activeRef.current?.id) setTree(data.tree)
      if (data.type === 'file_changed') {
        setTabs(prev => prev.map(tab => {
          if (tab.type !== 'file' || tab.filePath !== data.filename) return tab
          axios.get<{ content: string }>(API + '/api/projects/' + data.projectId + '/file/' + encodeURIComponent(data.filename))
            .then(r => setTabs(tabs => tabs.map(t => t.type === 'file' && t.filePath === data.filename ? { ...t, content: r.data.content, dirty: false } : t)))
          return tab
        }))
      }
    }
  }, [])

  function closeAgentSession(sessionId: number) {
    ws.current?.send(JSON.stringify({ type: 'agent_close', sessionId }))
  }

  function switchProject(proj: Project) {
    // закрываем все открытые сессии агентов текущего проекта на бэкенде
    tabs.forEach(t => { if (t.type === 'agent') closeAgentSession(t.sessionId) })
    setActive(proj)
    activeRef.current = proj
    setTabs([])
    setActiveTab(0)
    termCounter.current = 0
    agentNums.current = {}
    axios.get<FileNode[]>(API + '/api/projects/' + proj.id + '/tree').then(r => setTree(r.data))
    axios.get<GitBranches>(API + '/api/projects/' + proj.id + '/branches').then(r => setBranches(r.data))
    axios.get<GitCommit[]>(API + '/api/projects/' + proj.id + '/log').then(r => setLog(r.data))
  }

  function openFile(filePath: string, name: string) {
    if (!active) return
    const existing = tabs.findIndex(t => t.type === 'file' && t.filePath === filePath)
    if (existing >= 0) { setActiveTab(existing); return }
    axios.get<{ content: string }>(API + '/api/projects/' + active.id + '/file/' + encodeURIComponent(filePath))
      .then(r => {
        const newTab: Tab = { type: 'file', name, filePath, content: r.data.content, dirty: false }
        setTabs(prev => { const next = [...prev, newTab]; setActiveTab(next.length - 1); return next })
      })
  }

  function openTerminal() {
    if (!active) return
    const newTab: Tab = { type: 'terminal', projectId: active.id, termId: ++termCounter.current }
    setTabs(prev => { const next = [...prev, newTab]; setActiveTab(next.length - 1); return next })
  }

  function openAgent(agentType: string) {
    if (!active) return
    const sessionId = ++sessionCounter.current
    const num = agentNums.current[agentType] = (agentNums.current[agentType] || 0) + 1
    const newTab: Tab = { type: 'agent', sessionId, agentType, num }
    setTabs(prev => { const next = [...prev, newTab]; setActiveTab(next.length - 1); return next })
  }

  function saveFile(tabIndex: number) {
    const tab = tabs[tabIndex]
    if (!active || tab.type !== 'file') return
    axios.post(API + '/api/projects/' + active.id + '/file/' + encodeURIComponent(tab.filePath), { content: tab.content })
      .then(() => {
        setTabs(prev => prev.map((t, i) => i === tabIndex && t.type === 'file' ? { ...t, dirty: false } : t))
        refreshTree()
      })
  }
  saveRef.current = saveFile

  function closeTab(index: number, e: React.MouseEvent) {
    e.stopPropagation()
    const tab = tabs[index]
    if (tab?.type === 'agent') closeAgentSession(tab.sessionId)
    setTabs(prev => prev.filter((_, i) => i !== index))
    setActiveTab(prev => Math.max(0, index <= prev ? prev - 1 : prev))
  }

  function addProject() {
    const name = prompt('Название проекта:')
    if (!name) return
    axios.post<Project>(API + '/api/projects', { name }).then(r => { setProjects(p => [...p, r.data]); switchProject(r.data) })
  }

  function sendMessage(sessionId: number, agentType: string) {
    if (!active) return
    const text = (inputs[sessionId] || '').trim()
    if (!text || streaming[sessionId]) return
    setMessages(prev => ({ ...prev, [sessionId]: [...(prev[sessionId] || []), { role: 'user', text }] }))
    ws.current?.send(JSON.stringify({ type: 'chat', sessionId, agent: agentType, message: text, projectId: active.id }))
    setInputs(prev => ({ ...prev, [sessionId]: '' }))
  }

  const buildInfo = active ? build[active.id] : null
  const currentTab: Tab | undefined = tabs[activeTab]
  const activeFilePath = currentTab?.type === 'file' ? currentTab.filePath : null

  const actionBtn = (label: string, fn: () => void, color?: string) => (
    <button key={label} onClick={fn} style={{
      fontSize: 12, padding: '5px 10px', border: '1px solid ' + C.border, borderRadius: 3,
      background: 'transparent', color: color || C.text, cursor: 'pointer',
      display: 'block', width: '100%', textAlign: 'left', marginBottom: 4,
    }}
      onMouseEnter={e => (e.currentTarget.style.background = C.btnHover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13, background: C.bg, color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px', height: 35, background: C.topbar, borderBottom: '1px solid ' + C.border, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: C.textMuted, marginRight: 6 }}>ПРОЕКТЫ</span>
        {projects.map(p => (
          <button key={p.id} onClick={() => switchProject(p)} style={{ padding: '3px 12px', borderRadius: 3, border: 'none', cursor: 'pointer', fontSize: 12, background: active?.id === p.id ? C.accentBg : 'transparent', color: active?.id === p.id ? '#fff' : C.textMuted, outline: active?.id === p.id ? '1px solid ' + C.accent : 'none' }}>{p.name}</button>
        ))}
        <button onClick={addProject} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: C.textMuted, padding: '0 6px' }}>+</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.textDim, fontFamily: 'monospace' }}>{BACKEND_HOST}</span>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ width: 220, background: C.sidebar, borderRight: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '6px 12px', fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid ' + C.border, flexShrink: 0 }}>
            ПРОВОДНИК {active && <span style={{ color: C.textDim, fontWeight: 400 }}>— {active.name}</span>}
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <FileTree tree={tree} activeFile={activeFilePath} onOpen={openFile} onRefresh={() => refreshTree()} projectId={active?.id || ''} api={API} />
          </div>
          <div style={{ borderTop: '1px solid ' + C.border, padding: '6px 0', flexShrink: 0 }}>
            <div style={{ padding: '2px 12px', fontSize: 11, color: C.textDim, marginBottom: 4 }}>ВЕТКИ</div>
            {branches.all.map(b => (
              <div key={b} style={{ padding: '2px 16px', fontSize: 12, color: b === branches.current ? C.green : C.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9 }}>{b === branches.current ? '●' : '○'}</span>{b}
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', background: C.sidebar, borderBottom: '1px solid ' + C.border, height: 35, alignItems: 'flex-end', flexShrink: 0, overflowX: 'auto' }}>
            {tabs.map((tab, i) => (
              <div key={i} onClick={() => setActiveTab(i)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', height: 35, cursor: 'pointer', flexShrink: 0, userSelect: 'none', background: activeTab === i ? C.panel : 'transparent', color: activeTab === i ? C.text : C.textMuted, borderRight: '1px solid ' + C.border, borderTop: activeTab === i ? '1px solid ' + C.accent : '1px solid transparent', fontSize: 13 }}>
                <span>{tabLabel(tab)}</span>
                <span onClick={e => closeTab(i, e)} style={{ color: C.textDim, fontSize: 16, lineHeight: 1 }}>×</span>
              </div>
            ))}
          </div>

          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {/* Пустое состояние — нет открытых вкладок */}
            {tabs.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: C.textDim }}>
                <div style={{ fontSize: 28 }}>🤖</div>
                <div style={{ fontSize: 14 }}>{active ? 'Открой агента кнопками справа или файл слева' : 'Создай или выбери проект'}</div>
              </div>
            )}

            {/* Agent session tabs — всегда в DOM, чтобы сохранять историю/ввод */}
            {tabs.map((tab, i) => tab.type !== 'agent' ? null : (
              <div key={'agent-' + tab.sessionId} style={{ position: 'absolute', inset: 0, display: activeTab === i ? 'flex' : 'none', flexDirection: 'column' }}>
                <AgentSession
                  agentType={tab.agentType}
                  messages={messages[tab.sessionId] || []}
                  status={agentStatus[tab.sessionId]}
                  streaming={!!streaming[tab.sessionId]}
                  input={inputs[tab.sessionId] || ''}
                  onInput={v => setInputs(prev => ({ ...prev, [tab.sessionId]: v }))}
                  onSend={() => sendMessage(tab.sessionId, tab.agentType)}
                />
              </div>
            ))}

            {/* File tabs */}
            {tabs.map((tab, i) => tab.type !== 'file' ? null : (
              <div key={tab.filePath} style={{ position: 'absolute', inset: 0, display: activeTab === i ? 'flex' : 'none', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: C.sidebar, borderBottom: '1px solid ' + C.border, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, color: C.textMuted, fontFamily: 'monospace' }}>{tab.filePath}</span>
                  <span style={{ fontSize: 11, color: C.textDim }}>— {getLang(tab.name)}</span>
                  {tab.dirty && <span style={{ fontSize: 11, color: C.yellow }}>● несохранено</span>}
                  <button onClick={() => saveFile(i)} style={{ marginLeft: 'auto', padding: '3px 12px', borderRadius: 3, border: '1px solid ' + C.accent, background: C.accentBg, color: '#fff', cursor: 'pointer', fontSize: 12 }}>Сохранить (Ctrl+S)</button>
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <Editor
                    height="100%"
                    theme="vs-dark"
                    language={getLang(tab.name)}
                    value={tab.content}
                    onChange={val => setTabs(prev => prev.map((t, ti) => ti === i && t.type === 'file' ? { ...t, content: val ?? '', dirty: true } : t))}
                    onMount={(editor, monaco) => {
                      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current(i))
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

            {/* Terminal tabs — всегда в DOM */}
            {tabs.map((tab, i) => tab.type !== 'terminal' ? null : (
              <div key={'term-' + tab.termId} style={{ position: 'absolute', inset: 0, display: activeTab === i ? 'block' : 'none', background: '#1e1e1e' }}>
                <TerminalPanel projectId={tab.projectId} onFileSystemChange={() => refreshTree(tab.projectId)} />
              </div>
            ))}
          </div>
        </div>

        <div style={{ width: 220, background: C.sidebar, borderLeft: '1px solid ' + C.border, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '8px 12px 4px', fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid ' + C.border }}>SOURCE CONTROL</div>
          <div style={{ padding: '8px', overflowY: 'auto', maxHeight: 180 }}>
            {log.length === 0 && <div style={{ fontSize: 12, color: C.textDim, padding: '2px 4px' }}>Нет коммитов</div>}
            {log.slice(0, 10).map(c => (
              <div key={c.hash} style={{ fontSize: 11, display: 'flex', gap: 6, padding: '2px 4px' }}>
                <span style={{ color: C.accent, fontFamily: 'monospace', flexShrink: 0 }}>{c.hash}</span>
                <span style={{ color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.message}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '8px 12px 4px', fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: '0.08em', borderTop: '1px solid ' + C.border, borderBottom: '1px solid ' + C.border }}>СЕРВЕР</div>
          <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: buildInfo?.running ? C.green : C.textDim, display: 'inline-block' }}></span>
            <span style={{ fontSize: 12, color: buildInfo?.running ? C.green : C.textDim }}>{buildInfo?.running ? ':' + buildInfo.port + ' запущен' : 'остановлен'}</span>
          </div>
          <div style={{ padding: '8px 12px 4px', fontSize: 11, color: C.textMuted, fontWeight: 600, letterSpacing: '0.08em', borderTop: '1px solid ' + C.border }}>ДЕЙСТВИЯ</div>
          <div style={{ padding: '8px' }}>
            {AGENTS.map(a => actionBtn('🤖 ' + a.label, () => openAgent(a.type), agentColors[a.type]))}
            {actionBtn('⌨ Терминал', openTerminal)}
            {buildInfo?.running && actionBtn('🌐 Открыть :' + buildInfo.port, () => window.open('http://' + BACKEND_HOST + ':' + buildInfo!.port, '_blank'), C.green)}
            {actionBtn('Коммит', () => { const m = prompt('Сообщение коммита:'); if (m && active) axios.post(API + '/api/projects/' + active.id + '/commit', { message: m }).then(() => { switchProject(active); refreshTree() }) })}
            {actionBtn('Push', () => active && axios.post(API + '/api/projects/' + active.id + '/push'))}
            {actionBtn('Старт :8080', () => active && axios.post(API + '/api/projects/' + active.id + '/build/start', { port: 8080 }))}
            {actionBtn('Стоп', () => active && axios.post(API + '/api/projects/' + active.id + '/build/stop'))}
          </div>
          <div style={{ marginTop: 'auto', background: C.accent, padding: '3px 12px', display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#fff' }}>● {branches.current || 'main'}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginLeft: 'auto' }}>ai-workspace</span>
          </div>
        </div>
      </div>
    </div>
  )
}
