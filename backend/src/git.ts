import { simpleGit } from 'simple-git';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import { GitCommit, GitBranches, FileNode } from './types.js';

export async function getLog(projectPath: string): Promise<GitCommit[]> {
  try {
    const git = simpleGit(projectPath);
    const log = await git.log({ maxCount: 20 });
    return log.all.map((c: { hash: string; message: string; date: string }) => ({
      hash: c.hash.slice(0, 7), message: c.message, date: c.date
    }));
  } catch { return []; }
}

export async function getBranches(projectPath: string): Promise<GitBranches> {
  try {
    const git = simpleGit(projectPath);
    const res = await git.branch();
    return { all: res.all, current: res.current };
  } catch { return { all: [], current: '' }; }
}

export async function commitAll(projectPath: string, message: string): Promise<void> {
  const git = simpleGit(projectPath);
  await git.add('.');
  await git.commit(message);
}

export async function pushRepo(projectPath: string): Promise<void> {
  const git = simpleGit(projectPath);
  await git.push();
}

export function getFiles(projectPath: string): string[] {
  try {
    return readdirSync(projectPath).filter((i: string) => !i.startsWith('.'));
  } catch { return []; }
}

const IGNORE = new Set(['.git', 'node_modules', '.vite', 'dist', '__pycache__', '.next', '.nuxt']);

export function getFileTree(dirPath: string, root: string = dirPath): FileNode[] {
  try {
    const entries = readdirSync(dirPath);
    const nodes: FileNode[] = [];
    for (const name of entries) {
      if (IGNORE.has(name) || name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, name);
      const rel = path.relative(root, fullPath);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          nodes.push({ name, path: rel, type: 'dir', children: getFileTree(fullPath, root) });
        } else {
          nodes.push({ name, path: rel, type: 'file' });
        }
      } catch { continue; }
    }
    return nodes.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
  } catch { return []; }
}
