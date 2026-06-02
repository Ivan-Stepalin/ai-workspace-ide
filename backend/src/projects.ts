import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync } from 'fs';
import { simpleGit } from 'simple-git';
import path from 'path';
import { Project } from './types.js';

// Пути к данным настраиваются через env (.env), по умолчанию — папка ./data рядом с процессом.
// projects/ и workspace.db — пользовательские данные, в репозиторий не коммитятся.
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(DATA_DIR, 'projects');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'workspace.db');

mkdirSync(PROJECTS_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`);

// Автообнаружение: любые папки внутри PROJECTS_DIR, которых ещё нет в БД,
// регистрируются как проекты (так появляются репозитории, склонированные агентом/вручную).
function discoverProjects(): void {
  if (!existsSync(PROJECTS_DIR)) return;
  for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(entry.name);
    if (!exists) {
      db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)')
        .run(entry.name, entry.name, path.join(PROJECTS_DIR, entry.name));
    }
  }
}

export function listProjects(): Project[] {
  discoverProjects();
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
}

// Клонирование репозитория по URL как нового проекта
export async function cloneRepo(url: string, name?: string): Promise<Project> {
  if (!url || !/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) throw new Error('Некорректный URL репозитория');
  const base = (name || url.split('/').pop() || 'repo').replace(/\.git$/, '');
  const id = base.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'repo';
  const projectPath = path.join(PROJECTS_DIR, id);
  if (existsSync(projectPath)) {
    const existing = getProject(id);
    if (existing) return existing;
    throw new Error('Папка ' + id + ' уже существует');
  }
  await simpleGit().clone(url, projectPath);
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, base, projectPath);
  return { id, name: base, path: projectPath, created_at: Date.now() };
}

export async function createProject(name: string): Promise<Project> {
  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const projectPath = path.join(PROJECTS_DIR, id);
  if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig('user.email', 'agent@local');
  await git.addConfig('user.name', 'AI Agent');
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, name, projectPath);
  return { id, name, path: projectPath, created_at: Date.now() };
}

export function getProject(id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}
