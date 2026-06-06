import axios from 'axios'
import { API } from './config'

export type Role = 'sysadmin' | 'coder' | 'analyst' | 'tester' | 'tourist'
export type Action =
  | 'agent.run' | 'terminal.open' | 'git.commit' | 'git.push'
  | 'project.add' | 'project.delete' | 'chat.read' | 'user.manage'

export type User = {
  id: string; username: string; role: Role
  firstName: string; lastName: string; email: string
  permissions: Action[]
}

export const ROLES: Role[] = ['sysadmin', 'coder', 'analyst', 'tester', 'tourist']

export const roleLabel: Record<Role, string> = {
  sysadmin: 'Сисадмин', coder: 'Кодер', analyst: 'Аналитик', tester: 'Тестировщик', tourist: 'Гость',
}

// Подписи действий для чекбоксов в карточке пользователя (зеркало backend Action).
export const ACTIONS: { action: Action; label: string }[] = [
  { action: 'agent.run', label: 'Чат с агентом' },
  { action: 'terminal.open', label: 'Терминал (bash)' },
  { action: 'git.commit', label: 'Git: коммит' },
  { action: 'git.push', label: 'Git: пуш' },
  { action: 'project.add', label: 'Добавлять проекты' },
  { action: 'project.delete', label: 'Удалять проекты' },
  { action: 'chat.read', label: 'Чтение проектов и истории' },
  { action: 'user.manage', label: 'Управление пользователями' },
]

// Дефолтный набор прав по роли — зеркало backend MATRIX (шаблон при создании пользователя в UI).
export const defaultPermissions: Record<Role, Action[]> = {
  sysadmin: ['agent.run', 'terminal.open', 'git.commit', 'git.push', 'project.add', 'project.delete', 'chat.read', 'user.manage'],
  coder:    ['agent.run', 'terminal.open', 'git.commit', 'git.push', 'project.add', 'project.delete', 'chat.read'],
  analyst:  ['agent.run', 'chat.read'],
  tester:   ['agent.run', 'terminal.open', 'chat.read'],
  tourist:  ['chat.read'],
}

// Гейт UI по фактическим правам ПОЛЬЗОВАТЕЛЯ (источник истины всё равно сервер).
export const userCan = (user: User | undefined, action: Action): boolean =>
  !!user && user.permissions.includes(action)

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

// ── управление пользователями (только для роли с user.manage) ──
export type NewUser = {
  username: string; password: string; role: Role
  firstName?: string; lastName?: string; email?: string; permissions?: Action[]
}
export type UserPatch = Partial<{
  role: Role; firstName: string; lastName: string; email: string; permissions: Action[]; password: string
}>

export async function listUsers(): Promise<User[]> {
  return (await axios.get<{ users: User[] }>(API + '/api/auth/users')).data.users
}

export async function createUser(payload: NewUser): Promise<User> {
  return (await axios.post<{ user: User }>(API + '/api/auth/users', payload)).data.user
}

export async function updateUser(id: string, patch: UserPatch): Promise<User> {
  return (await axios.patch<{ user: User }>(API + '/api/auth/users/' + id, patch)).data.user
}

export async function deleteUser(id: string): Promise<void> {
  await axios.delete(API + '/api/auth/users/' + id)
}
