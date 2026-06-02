import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { WS_URL } from './config'

interface Props {
  projectId: string
  onFileSystemChange?: () => void
}

export default function TerminalPanel({ projectId, onFileSystemChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const readyRef = useRef(false)
  const fsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef(false)

  const onFsChangeRef = useRef(onFileSystemChange)
  onFsChangeRef.current = onFileSystemChange

  const send = useCallback((data: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
  }, [])

  const triggerFsUpdate = useCallback(() => {
    if (fsTimerRef.current) clearTimeout(fsTimerRef.current)
    fsTimerRef.current = setTimeout(() => onFsChangeRef.current?.(), 800)
  }, [])

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    const term = new XTerm({
      theme: {
        background: '#1e1e1e', foreground: '#cccccc', cursor: '#0078d4',
        cursorAccent: '#1e1e1e', selectionBackground: '#094771',
        black: '#1e1e1e', red: '#f44747', green: '#4ec9b0',
        yellow: '#dcdcaa', blue: '#569cd6', magenta: '#c586c0',
        cyan: '#9cdcfe', white: '#d4d4d4',
        brightBlack: '#808080', brightRed: '#f44747', brightGreen: '#4ec9b0',
        brightYellow: '#dcdcaa', brightBlue: '#569cd6', brightMagenta: '#c586c0',
        brightCyan: '#9cdcfe', brightWhite: '#ffffff',
      },
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      disableStdin: false,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fitAddon

    // Делаем первый fit после того как DOM готов
    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      // Небольшая задержка чтобы fit успел посчитать размеры
      setTimeout(() => {
        fitAddon.fit()
        ws.send(JSON.stringify({
          type: 'terminal_create',
          projectId,
          cols: term.cols,
          rows: term.rows,
        }))
      }, 50)
    }

    ws.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.type === 'terminal_ready') {
        terminalIdRef.current = data.terminalId
        readyRef.current = true
      }
      if (data.type === 'terminal_data' && data.terminalId === terminalIdRef.current) {
        term.write(data.data)
      }
      if (data.type === 'terminal_exit' && data.terminalId === terminalIdRef.current) {
        term.write('\r\n\x1b[31m[процесс завершён]\x1b[0m\r\n')
        readyRef.current = false
      }
    }

    ws.onclose = () => term.write('\r\n\x1b[31m[соединение закрыто]\x1b[0m\r\n')

    term.onData(data => {
      if (readyRef.current && terminalIdRef.current) {
        send({ type: 'terminal_input', terminalId: terminalIdRef.current, data })
        if (data === '\r' || data === '\n') triggerFsUpdate()
      }
    })

    // Resize только когда реально меняется размер контейнера
    let lastCols = 0
    let lastRows = 0
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          // Не подгоняем, пока контейнер скрыт (display:none → размер 0):
          // иначе fit ломает раскладку и текст уезжает.
          const c = containerRef.current
          if (!c || c.clientWidth === 0 || c.clientHeight === 0) return
          fitAddon.fit()
          const { cols, rows } = term
          if (cols !== lastCols || rows !== lastRows) {
            lastCols = cols
            lastRows = rows
            if (terminalIdRef.current) {
              send({ type: 'terminal_resize', terminalId: terminalIdRef.current, cols, rows })
            }
          }
        } catch { /* ignore */ }
      })
    })
    ro.observe(containerRef.current)

    return () => {
      if (fsTimerRef.current) clearTimeout(fsTimerRef.current)
      ro.disconnect()
      term.dispose()
      ws.close()
      wsRef.current = null
      termRef.current = null
      initializedRef.current = false
    }
  }, [projectId, send, triggerFsUpdate])

  return (
    <div style={{ width: '100%', height: '100%', background: '#1e1e1e', overflow: 'hidden' }}>
      <style>{`
        .xterm { height: 100% !important; padding: 0 !important; text-align: left; }
        .xterm-viewport { overflow-y: scroll !important; }
        .xterm-screen canvas { display: block; }
      `}</style>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', boxSizing: 'border-box', padding: '4px 0 4px 8px' }}
      />
    </div>
  )
}
