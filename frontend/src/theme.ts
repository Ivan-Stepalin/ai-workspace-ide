export const C = {
  bg: '#1e1e1e', sidebar: '#252526', panel: '#1e1e1e', topbar: '#323233',
  border: '#3c3c3c', inputBg: '#2d2d2d', text: '#cccccc', textMuted: '#858585',
  textDim: '#6a6a6a', accent: '#0078d4', accentBg: '#094771', msgAgent: '#2d2d2d',
  green: '#4ec9b0', yellow: '#dcdcaa', btnHover: '#2a2d2e',
}

export const agentColors: Record<string, string> = { manager: '#569cd6', coder: '#4ec9b0', reviewer: '#dcdcaa' }

export const statusLabels: Record<string, string> = {
  thinking: '🤔 Думает...', responding: '✍️ Пишет ответ...',
  using_tool: '🔧 Использует инструмент...', file_operation: '📁 Работает с файлами...',
  working: '⚙️ Работает...', done: '✅ Готово', error: '❌ Ошибка',
}

export const AGENTS: { type: string; label: string }[] = [
  { type: 'manager', label: 'Менеджер' },
  { type: 'coder', label: 'Кодер' },
  { type: 'reviewer', label: 'Ревьюер' },
]

export const agentLabel = (type: string): string => AGENTS.find(a => a.type === type)?.label || type

export type Message = { role: 'user' | 'agent'; text: string; agent?: string; streaming?: boolean }
