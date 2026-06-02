import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

const C = {
  text: '#cccccc', textMuted: '#858585', textDim: '#6a6a6a',
  accent: '#0078d4', accentBg: '#094771', btnHover: '#2a2d2e',
  border: '#3c3c3c', inputBg: '#3c3c3c', menuBg: '#252526',
  menuHover: '#094771',
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

interface CtxMenu {
  x: number; y: number
  node: FileNode
}

function FileIcon({ name, isDir, open }: { name: string; isDir?: boolean; open?: boolean }) {
  if (isDir) return <span style={{ fontSize: 12, marginRight: 4, color: open ? '#e8ab4b' : '#c8922a', flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const icons: Record<string, [string, string]> = {
    ts: ['TS', '#3178c6'], tsx: ['⚛', '#61dafb'], js: ['JS', '#f7df1e'], jsx: ['⚛', '#61dafb'],
    json: ['{}', '#f5a623'], html: ['◈', '#e34c26'], css: ['#', '#264de4'], scss: ['#', '#cd6799'],
    md: ['M↓', '#aaaaaa'], py: ['🐍', '#3572a5'], sh: ['$', '#89e051'], yml: ['⚙', '#cb171e'],
    yaml: ['⚙', '#cb171e'], sql: ['🗄', '#e38c00'], env: ['🔒', '#858585'], lock: ['🔒', '#858585'],
    svg: ['◉', '#ffb13b'], png: ['🖼', '#aaaaaa'], jpg: ['🖼', '#aaaaaa'], gif: ['🖼', '#aaaaaa'],
    txt: ['📄', '#aaaaaa'], gitignore: ['⊘', '#f05133'],
  }
  const [label, color] = icons[ext] || ['📄', '#aaaaaa']
  return <span style={{ fontSize: 10, fontWeight: 700, color, marginRight: 5, minWidth: 16, textAlign: 'center', fontFamily: 'monospace', flexShrink: 0, display: 'inline-block' }}>{label}</span>
}

interface NodeProps {
  node: FileNode; depth: number; activeFile: string | null
  onOpen: (path: string, name: string) => void
  onCtxMenu: (e: React.MouseEvent, node: FileNode) => void
}

function Node({ node, depth, activeFile, onOpen, onCtxMenu }: NodeProps) {
  const [open, setOpen] = useState(depth < 1)
  const isActive = node.type === 'file' && activeFile === node.path
  const pad = 6 + depth * 16

  if (node.type === 'dir') {
    return (
      <div>
        <div
          onClick={() => setOpen(o => !o)}
          onContextMenu={e => { e.preventDefault(); onCtxMenu(e, node) }}
          style={{ paddingLeft: pad, paddingRight: 4, paddingTop: 3, paddingBottom: 3, cursor: 'pointer', display: 'flex', alignItems: 'center', color: C.textMuted, userSelect: 'none', fontSize: 13 }}
          onMouseEnter={e => (e.currentTarget.style.background = C.btnHover)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <FileIcon name={node.name} isDir open={open} />
          <span style={{ color: open ? '#cccccc' : C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        </div>
        {open && node.children?.map(child => (
          <Node key={child.path} node={child} depth={depth + 1} activeFile={activeFile} onOpen={onOpen} onCtxMenu={onCtxMenu} />
        ))}
      </div>
    )
  }

  return (
    <div
      onClick={() => onOpen(node.path, node.name)}
      onContextMenu={e => { e.preventDefault(); onCtxMenu(e, node) }}
      style={{ paddingLeft: pad, paddingRight: 4, paddingTop: 3, paddingBottom: 3, cursor: 'pointer', display: 'flex', alignItems: 'center', background: isActive ? C.accentBg : 'transparent', color: isActive ? '#fff' : C.text, userSelect: 'none', fontSize: 13 }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = C.btnHover }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
    >
      <FileIcon name={node.name} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
    </div>
  )
}

interface ContextMenuProps {
  menu: CtxMenu; onClose: () => void
  onDelete: (node: FileNode) => void
  onRename: (node: FileNode) => void
  onNewFile: (node: FileNode) => void
  onNewDir: (node: FileNode) => void
}

function ContextMenu({ menu, onClose, onDelete, onRename, onNewFile, onNewDir }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const item = (label: string, fn: () => void, danger = false) => (
    <div
      key={label}
      onClick={() => { fn(); onClose() }}
      style={{ padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: danger ? '#f44747' : C.text, whiteSpace: 'nowrap' }}
      onMouseEnter={e => (e.currentTarget.style.background = C.menuHover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >{label}</div>
  )

  return (
    <div ref={ref} style={{
      position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999,
      background: C.menuBg, border: '1px solid ' + C.border,
      borderRadius: 4, minWidth: 160, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      padding: '4px 0',
    }}>
      {menu.node.type === 'dir' && item('📄 Новый файл', () => onNewFile(menu.node))}
      {menu.node.type === 'dir' && item('📁 Новая папка', () => onNewDir(menu.node))}
      {menu.node.type === 'dir' && <div style={{ height: 1, background: C.border, margin: '4px 0' }} />}
      {item('✏️ Переименовать', () => onRename(menu.node))}
      {item('🗑 Удалить', () => onDelete(menu.node), true)}
    </div>
  )
}

interface FileTreeProps {
  tree: FileNode[]; activeFile: string | null
  onOpen: (path: string, name: string) => void
  onRefresh: () => void; projectId: string; api: string
}

export default function FileTree({ tree, activeFile, onOpen, onRefresh, projectId, api }: FileTreeProps) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [creating, setCreating] = useState<{ type: 'file' | 'dir'; parentPath: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ node: FileNode } | null>(null)
  const [renameName, setRenameName] = useState('')

  function handleDelete(node: FileNode) {
    if (!confirm('Удалить ' + node.name + '?')) return
    axios.delete(api + '/api/projects/' + projectId + '/fs/' + encodeURIComponent(node.path)).then(onRefresh)
  }

  function handleRename(node: FileNode) {
    setRenaming({ node })
    setRenameName(node.name)
  }

  function submitRename() {
    if (!renaming || !renameName.trim()) { setRenaming(null); return }
    const oldPath = renaming.node.path
    const newPath = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/') + 1) + renameName : renameName
    axios.post(api + '/api/projects/' + projectId + '/fs/rename', { oldPath, newPath }).then(() => { onRefresh(); setRenaming(null) })
  }

  function handleCreate() {
    if (!newName.trim() || !creating) { setCreating(null); return }
    const fullPath = creating.parentPath ? creating.parentPath + '/' + newName : newName
    if (creating.type === 'file') {
      axios.post(api + '/api/projects/' + projectId + '/fs/file', { path: fullPath, content: '' }).then(() => { onRefresh(); setCreating(null); setNewName('') })
    } else {
      axios.post(api + '/api/projects/' + projectId + '/fs/dir', { path: fullPath }).then(() => { onRefresh(); setCreating(null); setNewName('') })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '3px 6px', gap: 2, borderBottom: '1px solid ' + C.border, flexShrink: 0 }}>
        {[
          { icon: '+📄', title: 'Новый файл', fn: () => { setCreating({ type: 'file', parentPath: '' }); setNewName('') } },
          { icon: '+📁', title: 'Новая папка', fn: () => { setCreating({ type: 'dir', parentPath: '' }); setNewName('') } },
          { icon: '↺', title: 'Обновить', fn: onRefresh },
        ].map(({ icon, title, fn }) => (
          <button key={title} onClick={fn} title={title} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, fontSize: 14, padding: '2px 5px', borderRadius: 3, lineHeight: 1 }}
            onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.background = C.btnHover }}
            onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; e.currentTarget.style.background = 'transparent' }}
          >{icon}</button>
        ))}
      </div>

      {/* New item input */}
      {creating && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid ' + C.border, display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 11, flexShrink: 0 }}>{creating.type === 'file' ? '📄' : '📁'}</span>
          <input autoFocus placeholder={creating.type === 'file' ? 'имя файла' : 'имя папки'} value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(null) }}
            onBlur={() => setTimeout(() => setCreating(null), 150)}
            style={{ flex: 1, background: C.inputBg, color: C.text, border: '1px solid ' + C.accent, borderRadius: 3, fontSize: 12, padding: '2px 6px', outline: 'none' }}
          />
        </div>
      )}

      {/* Rename input */}
      {renaming && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid ' + C.border, display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 11, flexShrink: 0 }}>✏️</span>
          <input autoFocus value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null) }}
            onBlur={() => setTimeout(() => setRenaming(null), 150)}
            style={{ flex: 1, background: C.inputBg, color: C.text, border: '1px solid ' + C.accent, borderRadius: 3, fontSize: 12, padding: '2px 6px', outline: 'none' }}
          />
        </div>
      )}

      {/* Tree */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tree.length === 0
          ? <div style={{ padding: '8px 16px', fontSize: 12, color: C.textDim, fontStyle: 'italic' }}>пусто</div>
          : tree.map(node => <Node key={node.path} node={node} depth={0} activeFile={activeFile} onOpen={onOpen} onCtxMenu={(e, n) => setCtxMenu({ x: e.clientX, y: e.clientY, node: n })} />)
        }
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onDelete={handleDelete}
          onRename={handleRename}
          onNewFile={n => { setCreating({ type: 'file', parentPath: n.path }); setNewName('') }}
          onNewDir={n => { setCreating({ type: 'dir', parentPath: n.path }); setNewName('') }}
        />
      )}
    </div>
  )
}
