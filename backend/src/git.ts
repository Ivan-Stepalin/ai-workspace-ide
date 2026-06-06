import { simpleGit } from 'simple-git';
import { GitCommit, GitBranches } from './types.js';

const CACHE_TTL = 20_000;
interface CacheEntry<T> { value: T; at: number }
const logCache  = new Map<string, CacheEntry<GitCommit[]>>();
const branchCache = new Map<string, CacheEntry<GitBranches>>();

function hit<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const e = cache.get(key);
  return (e && Date.now() - e.at < CACHE_TTL) ? e.value : null;
}

export function invalidateGitCache(projectPath: string): void {
  logCache.delete(projectPath);
  branchCache.delete(projectPath);
}

export async function getLog(projectPath: string): Promise<GitCommit[]> {
  const cached = hit(logCache, projectPath);
  if (cached) return cached;
  try {
    const git = simpleGit(projectPath);
    const log = await git.log({ maxCount: 20 });
    const result = log.all.map((c: { hash: string; message: string; date: string }) => ({
      hash: c.hash.slice(0, 7), message: c.message, date: c.date
    }));
    logCache.set(projectPath, { value: result, at: Date.now() });
    return result;
  } catch { return []; }
}

export async function getBranches(projectPath: string): Promise<GitBranches> {
  const cached = hit(branchCache, projectPath);
  if (cached) return cached;
  try {
    const git = simpleGit(projectPath);
    const res = await git.branch();
    const result = { all: res.all, current: res.current };
    branchCache.set(projectPath, { value: result, at: Date.now() });
    return result;
  } catch { return { all: [], current: '' }; }
}

export async function commitAll(projectPath: string, message: string): Promise<void> {
  const git = simpleGit(projectPath);
  await git.add('.');
  await git.commit(message);
  invalidateGitCache(projectPath);
}

export async function pushRepo(projectPath: string): Promise<void> {
  const git = simpleGit(projectPath);
  await git.push();
}
