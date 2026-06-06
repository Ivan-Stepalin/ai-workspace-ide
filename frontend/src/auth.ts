import axios from 'axios'
import { API } from './config'

export type Role = 'coder' | 'analyst' | 'tester' | 'tourist'
export type User = { id: string; username: string; role: Role }

export type Action =
  | 'agent.run' | 'terminal.open' | 'git.commit' | 'git.push'
  | 'project.add' | 'project.delete' | 'chat.read' | 'user.manage'

// Зеркало backend/src/permissions.ts — для скрытия/дизейбла кнопок на фронте.
// Бэкенд всё равно проверяет права независимо (источник истины — сервер).
const MATRIX: Record<Role, Action[]> = {
  coder:   ['agent.run', 'terminal.open', 'git.commit', 'git.push', 'project.add', 'project.delete', 'chat.read', 'user.manage'],
  analyst: ['agent.run', 'chat.read'],
  tester:  ['agent.run', 'terminal.open', 'chat.read'],
  tourist: ['chat.read'],
}

export const can = (role: Role | undefined, action: Action): boolean =>
  !!role && MATRIX[role].includes(action)

export const roleLabel: Record<Role, string> = {
  coder: 'Кодер', analyst: 'Аналитик', tester: 'Тестировщик', tourist: 'Гость',
}

export async function fetchMe(): Promise<User | null> {
  try { return (await axios.get<{ user: User }>(API + '/api/auth/me')).data.user }
  catch { return null }
}

export async function login(username: string, password: string): Promise<User> {
  return (await axios.post<{ user: User }>(API + '/api/auth/login', { username, password })).data.user
}

export async function logout(): Promise<void> {
  try { await axios.post(API + '/api/auth/logout') } catch { /* ignore */ }
}
