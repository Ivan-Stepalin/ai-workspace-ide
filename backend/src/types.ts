export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export interface GitCommit {
  hash: string;
  message: string;
  date: string;
}

export interface GitBranches {
  all: string[];
  current: string;
}

export interface BuildStatus {
  running: boolean;
  port?: number;
  project: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface WsMessage {
  type: string;
  agent?: string;
  message?: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string | number;
  text?: string;
  project?: string;
  port?: number;
  terminalId?: string;
  data?: string;
  cols?: number;
  rows?: number;
}
