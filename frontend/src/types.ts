export type Project = {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export type GitCommit = {
  hash: string;
  message: string;
  date: string;
}

export type GitBranches = {
  all: string[];
  current: string;
}

export type Message = {
  role: 'user' | 'agent';
  text: string;
  agent?: string;
  streaming?: boolean;
  projectId?: string;
}

export type BuildInfo = {
  running: boolean;
  port?: number;
  project: string;
}
