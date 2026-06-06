// Ролевая модель доступа. Две оси не путать: технический тип агента (manager/overseer —
// «где работаем») задаётся отдельно; здесь — РОЛЬ ПОЛЬЗОВАТЕЛЯ («что можно»).
//
// Права теперь храним ПО ПОЛЬЗОВАТЕЛЮ (массив Action в users.permissions). Роль играет
// роль шаблона: при создании юзера его права засеиваются из матрицы роли, дальше сисадмин
// правит их пер-юзерно чекбоксами. Гейтинг проверяет именно права пользователя (userCan),
// а не роль. Роль остаётся для подписи и для ролевой надстройки промпта агента (ROLE_NOTES).
export type Role = 'sysadmin' | 'coder' | 'analyst' | 'tester' | 'tourist';
export const ROLES: Role[] = ['sysadmin', 'coder', 'analyst', 'tester', 'tourist'];

export type Action =
  | 'agent.run'       // запустить чат с агентом
  | 'terminal.open'   // открыть сырой bash-терминал
  | 'git.commit'
  | 'git.push'
  | 'project.add'     // создать/клонировать проект
  | 'project.delete'
  | 'chat.read'       // читать список проектов и историю чатов
  | 'user.manage';    // добавлять/удалять пользователей (только сисадмин)

export const ACTIONS: Action[] = [
  'agent.run', 'terminal.open', 'git.commit', 'git.push',
  'project.add', 'project.delete', 'chat.read', 'user.manage',
];

// Шаблоны прав по ролям (дефолт при создании пользователя). sysadmin — суперюзер (всё, в т.ч.
// управление пользователями); coder — полный доступ к проекту, но БЕЗ управления юзерами.
const MATRIX: Record<Role, Action[]> = {
  sysadmin: ['agent.run', 'terminal.open', 'git.commit', 'git.push', 'project.add', 'project.delete', 'chat.read', 'user.manage'],
  coder:    ['agent.run', 'terminal.open', 'git.commit', 'git.push', 'project.add', 'project.delete', 'chat.read'],
  analyst:  ['agent.run', 'chat.read'],                       // исследует/планирует: агент + чтение
  tester:   ['agent.run', 'terminal.open', 'chat.read'],      // гоняет тесты: агент + терминал, без commit/push
  tourist:  ['chat.read'],                                    // гость: только чтение
};

// Дефолтный набор прав для роли (шаблон при создании пользователя).
export function defaultPermissions(role: Role): Action[] {
  return [...(MATRIX[role] || [])];
}

// Проверка по РОЛИ (шаблон) — оставлена для совместимости/засева.
export function can(role: Role | undefined, action: Action): boolean {
  return !!role && (MATRIX[role] || []).includes(action);
}

// Проверка по фактическим правам ПОЛЬЗОВАТЕЛЯ — основной гейт.
export function userCan(permissions: Action[] | undefined, action: Action): boolean {
  return !!permissions && permissions.includes(action);
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as string[]).includes(v);
}

export function isAction(v: unknown): v is Action {
  return typeof v === 'string' && (ACTIONS as string[]).includes(v);
}
