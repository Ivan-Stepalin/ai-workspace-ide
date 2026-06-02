import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { simpleGit } from 'simple-git';
import path from 'path';
import { Project } from './types.js';

// Пути к данным настраиваются через env (.env), по умолчанию — папка ./data рядом с процессом.
// projects/ и workspace.db — пользовательские данные, в репозиторий не коммитятся.
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(DATA_DIR, 'projects');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'workspace.db');

mkdirSync(PROJECTS_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`);

export function listProjects(): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
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
