import { useState, useEffect, useRef, memo } from 'react'
import axios from 'axios'
import ConfirmModal from './ConfirmModal'

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
  if (isDir) return <span className="mr-1 shrink-0 text-xs" style={{ color: open ? '#e8ab4b' : '#c8922a' }}>{open ? '▾' : '▸'}</span>
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
  return <span className="mr-1.5 inline-block min-w-4 shrink-0 text-center font-mono text-[10px] font-bold" style={{ color }}>{label}</span>
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
          style={{ paddingLeft: pad }}
          className="flex cursor-pointer select-none items-center py-[3px] pr-1 text-[13px] text-muted transition-colors hover:bg-white/5"
        >
          <FileIcon name={node.name} isDir open={open} />
          <span className={'overflow-hidden text-ellipsis whitespace-nowrap ' + (open ? 'text-fg' : 'text-muted')}>{node.name}</span>
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
      style={{ paddingLeft: pad }}
      className={
        'flex cursor-pointer select-none items-center py-[3px] pr-1 text-[13px] transition-colors ' +
        (isActive ? 'bg-accentbg text-white' : 'text-fg hover:bg-white/5')
      }
    >
      <FileIcon name={node.name} />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{node.name}</span>
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
      className={'cursor-pointer whitespace-nowrap px-3.5 py-1.5 text-[13px] transition-colors hover:bg-accentbg ' + (danger ? 'text-danger' : 'text-fg')}
    >{label}</div>
  )

  return (
    <div
      ref={ref}
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-[9999] min-w-40 rounded-md border border-edge bg-sidebar py-1 shadow-xl shadow-black/50"
    >
      {menu.node.type === 'dir' && item('📄 Новый файл', () => onNewFile(menu.node))}
      {menu.node.type === 'dir' && item('📁 Новая папка', () => onNewDir(menu.node))}
      {menu.node.type === 'dir' && <div className="my-1 h-px bg-edge" />}
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

const fieldCls = 'flex-1 rounded-md border border-accent bg-edge px-1.5 py-0.5 text-xs text-fg outline-none'

function FileTree({ tree, activeFile, onOpen, onRefresh, projectId, api }: FileTreeProps) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [creating, setCreating] = useState<{ type: 'file' | 'dir'; parentPath: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ node: FileNode } | null>(null)
  const [renameName, setRenameName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<FileNode | null>(null)

  function handleDelete(node: FileNode) {
    setPendingDelete(node)
  }

  function confirmDelete() {
    const node = pendingDelete
    setPendingDelete(null)
    if (node) axios.delete(api + '/api/projects/' + projectId + '/fs/' + encodeURIComponent(node.path)).then(onRefresh)
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
    <div className="relative flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge p-2">
        {[
          { icon: '+📄', title: 'Новый файл', fn: () => { setCreating({ type: 'file', parentPath: '' }); setNewName('') } },
          { icon: '+📁', title: 'Новая папка', fn: () => { setCreating({ type: 'dir', parentPath: '' }); setNewName('') } },
          { icon: '↺', title: 'Обновить', fn: onRefresh },
        ].map(({ icon, title, fn }) => (
          <button
            key={title} onClick={fn} title={title}
            className="rounded-md border border-edge px-3 py-1.5 text-base leading-none text-muted transition-colors hover:bg-white/5 hover:text-fg active:bg-white/10"
          >{icon}</button>
        ))}
      </div>

      {/* New item input */}
      {creating && (
        <div className="flex flex-shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
          <span className="shrink-0 text-[11px]">{creating.type === 'file' ? '📄' : '📁'}</span>
          <input autoFocus placeholder={creating.type === 'file' ? 'имя файла' : 'имя папки'} value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(null) }}
            onBlur={() => setTimeout(() => setCreating(null), 150)}
            className={fieldCls}
          />
        </div>
      )}

      {/* Rename input */}
      {renaming && (
        <div className="flex flex-shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
          <span className="shrink-0 text-[11px]">✏️</span>
          <input autoFocus value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null) }}
            onBlur={() => setTimeout(() => setRenaming(null), 150)}
            className={fieldCls}
          />
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto">
        {tree.length === 0
          ? <div className="px-4 py-2 text-xs italic text-dim">пусто</div>
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

      <ConfirmModal
        open={!!pendingDelete}
        title="Удаление"
        message={pendingDelete ? `Удалить «${pendingDelete.name}»?${pendingDelete.type === 'dir' ? '\n\nПапка со всем содержимым будет удалена.' : ''}` : ''}
        confirmLabel="Удалить"
        danger
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  )
}

// memo: дерево перерисовывается только при смене самого дерева/активного файла/проекта,
// а не на каждый ререндер App (напр. ввод в редакторе). Колбэки onOpen/onRefresh приходят
// из App стабильными по идентичности (ref-обёртка/useCallback) — иначе memo был бы бесполезен.
export default memo(FileTree)
