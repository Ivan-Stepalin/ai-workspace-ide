// Аутентификация и пользователи. Пароли — scrypt (node:crypto, без внешних либ),
// сессия — HMAC-подписанный токен {id,exp} в httpOnly-cookie. Источник секрета — env
// AUTH_SECRET (с предупреждением о небезопасном дефолте). Первый пользователь сидится
// из env BOOTSTRAP_ADMIN ("логин:пароль" или "логин:пароль:роль", по умолчанию coder).
import crypto from 'crypto';
import Database from 'better-sqlite3';
import type { Express, Request, Response, NextFunction } from 'express';
import { DB_PATH } from './projects.js';
import { can, isRole, Role } from './permissions.js';

export interface User { id: string; username: string; role: Role; }
interface UserRow { id: string; username: string; pass_hash: string; role: Role; created_at: number; }

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
    created_at INTEGER NOT NULL
  )`);

  if (SECRET === DEFAULT_SECRET) console.warn('[auth] AUTH_SECRET не задан — используется небезопасный дефолт. Задай AUTH_SECRET в проде.');

  const boot = process.env.BOOTSTRAP_ADMIN;
  if (boot) {
    const [u, p, r] = boot.split(':');
    const role: Role = isRole(r) ? r : 'coder';
    if (u && p && !getUserByName(u)) { createUser(u, p, role); console.log(`[auth] создан bootstrap-пользователь «${u}» (${role})`); }
  }
  if (countUsers() === 0) console.warn('[auth] нет ни одного пользователя — задай BOOTSTRAP_ADMIN="логин:пароль" и перезапусти бэкенд.');
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
export function createUser(username: string, password: string, role: Role): User {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, hashPassword(password), role, Date.now());
  return { id, username, role };
}

// ── токен (HMAC) ──
function sign(user: UserRow): string {
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
    return u ? { id: u.id, username: u.username, role: u.role } : null;
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
    res.setHeader('Set-Cookie', cookieStr(sign(u), Math.floor(TOKEN_TTL_MS / 1000)));
    res.json({ user: { id: u.id, username: u.username, role: u.role } });
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

  // Создание пользователей — только для роли с user.manage (фактически админ-coder).
  app.post('/api/auth/users', requireAuth, (req, res) => {
    if (!can(reqUser(req)!.role, 'user.manage')) { res.status(403).json({ error: 'Нет прав' }); return; }
    const { username, password, role } = req.body || {};
    if (!username || !password || !isRole(role)) { res.status(400).json({ error: 'username, password и корректная role обязательны' }); return; }
    if (getUserByName(username)) { res.status(409).json({ error: 'Пользователь уже существует' }); return; }
    res.json({ user: createUser(username, password, role) });
  });
}
