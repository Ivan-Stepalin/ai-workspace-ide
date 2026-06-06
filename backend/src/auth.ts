// Аутентификация и пользователи. Пароли — scrypt (node:crypto, без внешних либ),
// сессия — HMAC-подписанный токен {id,exp} в httpOnly-cookie. Источник секрета — env
// AUTH_SECRET (с предупреждением о небезопасном дефолте). Первый пользователь сидится
// из env BOOTSTRAP_ADMIN ("логин:пароль" или "логин:пароль:роль", по умолчанию sysadmin).
//
// Права хранятся ПО ПОЛЬЗОВАТЕЛЮ (users.permissions — JSON-массив Action). Роль — лишь
// шаблон при создании + подпись + ролевая надстройка промпта; гейтинг смотрит на permissions.
import crypto from 'crypto';
import Database from 'better-sqlite3';
import type { Express, Request, Response, NextFunction } from 'express';
import { DB_PATH } from './projects.js';
import { Role, Action, isRole, isAction, defaultPermissions, userCan } from './permissions.js';

export interface User {
  id: string;
  username: string;
  role: Role;
  firstName: string;
  lastName: string;
  email: string;
  permissions: Action[];
}
interface UserRow {
  id: string; username: string; pass_hash: string; role: Role;
  first_name: string | null; last_name: string | null; email: string | null;
  permissions: string | null; created_at: number;
}

const COOKIE = 'aiws_token';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SECRET = 'dev-insecure-secret-change-me';
const SECRET = process.env.AUTH_SECRET || DEFAULT_SECRET;

let db: Database.Database;

export function initAuth(): void {
  db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    permissions TEXT,
    created_at INTEGER NOT NULL
  )`);
  // Миграция старых БД: добавить недостающие колонки (ALTER падает, если колонка уже есть — глушим).
  for (const col of ['first_name TEXT', 'last_name TEXT', 'email TEXT', 'permissions TEXT']) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* колонка уже есть */ }
  }

  if (SECRET === DEFAULT_SECRET) console.warn('[auth] AUTH_SECRET не задан — используется небезопасный дефолт. Задай AUTH_SECRET в проде.');

  const boot = process.env.BOOTSTRAP_ADMIN;
  if (boot) {
    const [u, p, r] = boot.split(':');
    const role: Role = isRole(r) ? r : 'sysadmin';
    if (u && p && !getUserByName(u)) { createUser({ username: u, password: p, role }); console.log(`[auth] создан bootstrap-пользователь «${u}» (${role})`); }
  }
  if (countUsers() === 0) console.warn('[auth] нет ни одного пользователя — задай BOOTSTRAP_ADMIN="логин:пароль" и перезапусти бэкенд.');
  ensureUserManager();
}

// Защита от локаута: если ни у кого нет права user.manage — повышаем bootstrap-админа
// (или первого пользователя) до sysadmin, иначе управлять юзерами стало бы некому.
function ensureUserManager(): void {
  const users = listUsers();
  if (users.some(u => userCan(u.permissions, 'user.manage'))) return;
  const adminName = process.env.BOOTSTRAP_ADMIN?.split(':')[0];
  const targetRow = (adminName && getUserByName(adminName)) || db.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').get() as UserRow | undefined;
  if (!targetRow) return;
  db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?')
    .run('sysadmin', JSON.stringify(defaultPermissions('sysadmin')), targetRow.id);
  console.log(`[auth] нет ни одного пользователя с user.manage — «${targetRow.username}» повышен до sysadmin.`);
}

// ── пароли (scrypt) ──
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── маппинг строки БД → User (права из JSON; если пусто — дефолт роли) ──
function rowToUser(r: UserRow): User {
  let perms: Action[];
  try {
    const parsed = r.permissions ? JSON.parse(r.permissions) : null;
    perms = Array.isArray(parsed) ? parsed.filter(isAction) : defaultPermissions(r.role);
  } catch { perms = defaultPermissions(r.role); }
  return {
    id: r.id, username: r.username, role: r.role,
    firstName: r.first_name ?? '', lastName: r.last_name ?? '', email: r.email ?? '',
    permissions: perms,
  };
}

// ── пользователи ──
function getUserByName(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}
function getUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}
function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export interface CreateUserOpts {
  username: string; password: string; role: Role;
  firstName?: string; lastName?: string; email?: string; permissions?: Action[];
}
export function createUser(opts: CreateUserOpts): User {
  const id = crypto.randomUUID();
  const perms = opts.permissions?.filter(isAction) ?? defaultPermissions(opts.role);
  db.prepare(`INSERT INTO users (id, username, pass_hash, role, first_name, last_name, email, permissions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, opts.username, hashPassword(opts.password), opts.role,
      opts.firstName ?? '', opts.lastName ?? '', opts.email ?? '', JSON.stringify(perms), Date.now());
  return rowToUser(getUserById(id)!);
}

export interface UpdateUserPatch {
  role?: Role; firstName?: string; lastName?: string; email?: string; permissions?: Action[]; password?: string;
}
export function updateUser(id: string, patch: UpdateUserPatch): User | undefined {
  const row = getUserById(id);
  if (!row) return undefined;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.role !== undefined && isRole(patch.role)) { sets.push('role = ?'); vals.push(patch.role); }
  if (patch.firstName !== undefined) { sets.push('first_name = ?'); vals.push(patch.firstName); }
  if (patch.lastName !== undefined) { sets.push('last_name = ?'); vals.push(patch.lastName); }
  if (patch.email !== undefined) { sets.push('email = ?'); vals.push(patch.email); }
  if (patch.permissions !== undefined) { sets.push('permissions = ?'); vals.push(JSON.stringify(patch.permissions.filter(isAction))); }
  if (patch.password) { sets.push('pass_hash = ?'); vals.push(hashPassword(patch.password)); }
  if (sets.length) { vals.push(id); db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  return rowToUser(getUserById(id)!);
}

function listUsers(): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(rowToUser);
}
function deleteUserById(id: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ── токен (HMAC) ──
function sign(user: User): string {
  const payload = Buffer.from(JSON.stringify({ id: user.id, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifyToken(token: string | undefined): User | null {
  if (!token) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { id: string; exp: number };
    if (!data.exp || data.exp < Date.now()) return null;
    const u = getUserById(data.id);
    return u ? rowToUser(u) : null;
  } catch { return null; }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Достать пользователя из cookie-заголовка (используется и в Express, и при апгрейде WS).
export function userFromCookieHeader(header: string | undefined): User | null {
  return verifyToken(parseCookies(header)[COOKIE]);
}

function cookieStr(token: string, maxAgeSec: number): string {
  const parts = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (process.env.AUTH_COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

// req.user — типобезопасно через хелпер (без расширения глобального Request).
export function reqUser(req: Request): User | undefined {
  return (req as Request & { user?: User }).user;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const u = userFromCookieHeader(req.headers.cookie);
  if (!u) { res.status(401).json({ error: 'Не авторизован' }); return; }
  (req as Request & { user?: User }).user = u;
  next();
}

export function registerAuthRoutes(app: Express): void {
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const u = username ? getUserByName(username) : undefined;
    if (!u || !verifyPassword(password || '', u.pass_hash)) { res.status(401).json({ error: 'Неверный логин или пароль' }); return; }
    res.setHeader('Set-Cookie', cookieStr(sign(rowToUser(u)), Math.floor(TOKEN_TTL_MS / 1000)));
    res.json({ user: rowToUser(u) });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', cookieStr('', 0));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const u = userFromCookieHeader(req.headers.cookie);
    if (!u) { res.status(401).json({ error: 'Не авторизован' }); return; }
    res.json({ user: u });
  });

  // Управление пользователями — только для роли с user.manage (сисадмин).
  const requireManage = (req: Request, res: Response): boolean => {
    if (!userCan(reqUser(req)?.permissions, 'user.manage')) { res.status(403).json({ error: 'Нет прав' }); return false; }
    return true;
  };

  app.get('/api/auth/users', requireAuth, (req, res) => {
    if (!requireManage(req, res)) return;
    res.json({ users: listUsers() });
  });

  app.post('/api/auth/users', requireAuth, (req, res) => {
    if (!requireManage(req, res)) return;
    const { username, password, role, firstName, lastName, email, permissions } = req.body || {};
    if (!username || !password || !isRole(role)) { res.status(400).json({ error: 'username, password и корректная role обязательны' }); return; }
    if (getUserByName(username)) { res.status(409).json({ error: 'Пользователь уже существует' }); return; }
    const perms = Array.isArray(permissions) ? permissions.filter(isAction) : undefined;
    res.json({ user: createUser({ username, password, role, firstName, lastName, email, permissions: perms }) });
  });

  app.patch('/api/auth/users/:id', requireAuth, (req, res) => {
    if (!requireManage(req, res)) return;
    const target = getUserById(req.params.id);
    if (!target) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
    const { role, firstName, lastName, email, permissions, password } = req.body || {};
    // Не дать снять у себя user.manage — иначе сам себя запрёшь.
    if (req.params.id === reqUser(req)!.id && Array.isArray(permissions) && !permissions.includes('user.manage')) {
      res.status(400).json({ error: 'Нельзя снять у себя право управления пользователями' }); return;
    }
    const patch: UpdateUserPatch = {};
    if (isRole(role)) patch.role = role;
    if (typeof firstName === 'string') patch.firstName = firstName;
    if (typeof lastName === 'string') patch.lastName = lastName;
    if (typeof email === 'string') patch.email = email;
    if (Array.isArray(permissions)) patch.permissions = permissions.filter(isAction);
    if (typeof password === 'string' && password) patch.password = password;
    res.json({ user: updateUser(req.params.id, patch) });
  });

  app.delete('/api/auth/users/:id', requireAuth, (req, res) => {
    if (!requireManage(req, res)) return;
    if (req.params.id === reqUser(req)!.id) { res.status(400).json({ error: 'Нельзя удалить самого себя' }); return; }
    if (!getUserById(req.params.id)) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
    deleteUserById(req.params.id);
    res.json({ ok: true });
  });
}
