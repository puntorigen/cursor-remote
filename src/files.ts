import { exec } from 'child_process';
import { slugToPath } from './transcripts';

export interface FileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
}

export interface FileDiff {
  path: string;
  diff: string;
}

const STATUS_MAP: Record<string, FileChange['status']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
};

function runGit(cwd: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        reject(err);
      } else {
        resolve(stdout || '');
      }
    });
  });
}

export async function getGitStatus(projectSlug: string): Promise<FileChange[]> {
  const cwd = slugToPath(projectSlug);
  const output = await runGit(cwd, 'status --porcelain');
  const changes: FileChange[] = [];

  for (const line of output.split('\n').filter((l) => l.trim())) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3).trim();

    if (indexStatus !== ' ' && indexStatus !== '?') {
      changes.push({
        path: filePath,
        status: STATUS_MAP[indexStatus] || 'modified',
        staged: true,
      });
    }

    if (workTreeStatus !== ' ' && workTreeStatus !== undefined) {
      const status =
        workTreeStatus === '?' ? 'untracked' : STATUS_MAP[workTreeStatus] || 'modified';
      if (!changes.some((c) => c.path === filePath && !c.staged)) {
        changes.push({ path: filePath, status, staged: false });
      }
    }
  }

  return changes;
}

export async function getFileDiff(
  projectSlug: string,
  filePath: string,
  staged = false
): Promise<FileDiff> {
  const cwd = slugToPath(projectSlug);
  const flag = staged ? '--cached ' : '';
  const diff = await runGit(cwd, `diff ${flag}-- "${filePath}"`);
  return { path: filePath, diff };
}

export async function getGitDiffStat(projectSlug: string): Promise<string> {
  const cwd = slugToPath(projectSlug);
  return runGit(cwd, 'diff --stat');
}
