// Цвета подтипов агентов используются динамически в JS (подпись/чип/точка статуса).
// Остальная палитра вынесена в дизайн-токены Tailwind (src/index.css @theme).
export const agentColors: Record<string, string> = { manager: '#569cd6', coder: '#4ec9b0', reviewer: '#dcdcaa', overseer: '#c586c0' }

export const OVERSEER = 'overseer'

export const AGENTS: { type: string; label: string }[] = [
  { type: 'manager', label: 'Менеджер' },
  { type: 'coder', label: 'Кодер' },
  { type: 'reviewer', label: 'Ревьюер' },
]

export const agentLabel = (type: string): string =>
  type === OVERSEER ? 'Общий менеджер' : (AGENTS.find(a => a.type === type)?.label || type)
