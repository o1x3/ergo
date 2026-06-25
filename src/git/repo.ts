import { exec } from '@/util/exec';

export class GitError extends Error {}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr, exitCode } = await exec(['git', ...args], { cwd });
  if (exitCode !== 0) {
    throw new GitError(
      `git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  const { exitCode } = await exec(
    ['git', 'rev-parse', '--is-inside-work-tree'],
    { cwd },
  );
  return exitCode === 0;
}

export async function repoRoot(cwd?: string): Promise<string> {
  const out = await git(['rev-parse', '--show-toplevel'], cwd);
  return out.trim();
}

export async function currentBranch(cwd?: string): Promise<string> {
  const out = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return out.trim();
}

export async function headSha(cwd?: string): Promise<string> {
  const out = await git(['rev-parse', 'HEAD'], cwd);
  return out.trim();
}

// Resolve a ref to a full SHA; returns undefined if it doesn't exist.
export async function resolveRef(
  ref: string,
  cwd?: string,
): Promise<string | undefined> {
  const { stdout, exitCode } = await exec(
    ['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { cwd },
  );
  return exitCode === 0 ? stdout.trim() : undefined;
}

// Best-effort default base branch detection: origin/HEAD, then common names.
export async function detectDefaultBase(cwd?: string): Promise<string> {
  const { stdout, exitCode } = await exec(
    ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd },
  );
  if (exitCode === 0 && stdout.trim()) {
    return stdout.trim();
  }
  for (const candidate of [
    'origin/main',
    'origin/master',
    'main',
    'master',
    'develop',
  ]) {
    if (await resolveRef(candidate, cwd)) return candidate;
  }
  return 'HEAD';
}

// merge-base of two refs (the fork point), for three-dot diff semantics.
export async function mergeBase(
  a: string,
  b: string,
  cwd?: string,
): Promise<string | undefined> {
  const { stdout, exitCode } = await exec(['git', 'merge-base', a, b], { cwd });
  return exitCode === 0 ? stdout.trim() : undefined;
}

export type WorktreeStatus = {
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  untracked: string[];
};

export async function worktreeStatus(cwd?: string): Promise<WorktreeStatus> {
  // --untracked-files=all expands fully-untracked directories into individual
  // file entries (git otherwise reports just `dir/`, which we can't diff).
  const out = await git(
    ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
    cwd,
  );
  // With -z, fields are NUL-separated and a rename/copy (X or Y is R/C) emits a
  // SECOND field for the source path that belongs to the same entry — consume it
  // so it isn't mistaken for a new status record.
  const fields = out.split('\0');
  let hasStaged = false;
  let hasUnstaged = false;
  const untracked: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length === 0) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(path);
      continue;
    }
    if (x && x !== ' ' && x !== '?') hasStaged = true;
    if (y && y !== ' ' && y !== '?') hasUnstaged = true;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i++; // skip the rename/copy source field
    }
  }
  return {
    hasStagedChanges: hasStaged,
    hasUnstagedChanges: hasUnstaged,
    untracked,
  };
}

export { git };
