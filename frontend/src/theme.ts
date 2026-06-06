// Цвета подтипов агентов используются динамически в JS (подпись/чип/точка статуса).
// Остальная палитра — CSS-переменные в src/theme.css (:root).
export const agentColors: Record<string, string> = { manager: '#569cd6', overseer: '#c586c0' }

export const OVERSEER = 'overseer'

export const AGENTS: { type: string; label: string }[] = [
  { type: 'manager', label: 'Агент' },
]

export const agentLabel = (type: string): string =>
  type === OVERSEER ? 'Общий менеджер' : (AGENTS.find(a => a.type === type)?.label || type)
