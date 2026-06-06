// Ролевая модель доступа. Две оси не путать: технический тип агента (manager/overseer —
// «где работаем») задаётся отдельно; здесь — РОЛЬ ПОЛЬЗОВАТЕЛЯ («что можно»).
export type Role = 'coder' | 'analyst' | 'tester' | 'tourist';
export const ROLES: Role[] = ['coder', 'analyst', 'tester', 'tourist'];

export type Action =
  | 'agent.run'       // запустить чат с агентом
  | 'terminal.open'   // открыть сырой bash-терминал
  | 'git.commit'
  | 'git.push'
  | 'project.add'     // создать/клонировать проект
  | 'project.delete'
  | 'chat.read'       // читать список проектов и историю чатов
  | 'user.manage';    // создавать пользователей (фактически админ)

// Матрица возможностей по ролям. coder = полный доступ (в т.ч. управление юзерами).
const MATRIX: Record<Role, Action[]> = {
  coder:   ['agent.run', 'terminal.open', 'git.commit', 'git.push', 'project.add', 'project.delete', 'chat.read', 'user.manage'],
  analyst: ['agent.run', 'chat.read'],                       // исследует/планирует: агент + чтение, без правок git и терминала
  tester:  ['agent.run', 'terminal.open', 'chat.read'],      // гоняет тесты: агент + терминал, но без commit/push
  tourist: ['chat.read'],                                    // гость: только чтение, без агента/терминала
};

export function can(role: Role | undefined, action: Action): boolean {
  return !!role && (MATRIX[role] || []).includes(action);
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as string[]).includes(v);
}
