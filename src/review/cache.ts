import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DiffSet, ReviewTarget } from '@/git/diff';
import type { ReviewResult } from '@/review/schema';
import { ergoHome } from '@/util/paths';

// A persisted review, so `ergo review findings` can replay the last result and
// `ergo fix` can apply suggested patches without re-running (and re-paying).
export interface CachedReview {
  version: 1;
  savedAt: string;
  repoRoot: string;
  context: {
    target: string;
    base?: string;
    head?: string;
    files: {
      path: string;
      status: string;
      additions: number;
      deletions: number;
      language: string;
    }[];
    // sha256 of each file's content at review time, so `ergo fix` can detect a
    // file that changed since the review and refuse to apply a stale patch.
    fileHashes: Record<string, string>;
  };
  review: ReviewResult;
}

function cachePath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return join(ergoHome(env), 'reviews', `${key}.json`);
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function hashFile(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    return hashContent(await readFile(join(root, path), 'utf8'));
  } catch {
    return undefined;
  }
}

export async function saveReviewCache(
  repoRoot: string,
  diff: DiffSet,
  review: ReviewResult,
): Promise<void> {
  const path = cachePath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  const fileHashes: Record<string, string> = {};
  await Promise.all(
    diff.files.map(async (f) => {
      const h = await hashFile(repoRoot, f.path);
      if (h) fileHashes[f.path] = h;
    }),
  );
  const payload: CachedReview = {
    version: 1,
    savedAt: new Date().toISOString(),
    repoRoot,
    context: {
      target: diff.target.kind,
      base: diff.base,
      head: diff.head,
      files: diff.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        language: f.language,
      })),
      fileHashes,
    },
    review,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function loadReviewCache(
  repoRoot: string,
): Promise<CachedReview | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(cachePath(repoRoot), 'utf8'),
    ) as CachedReview;
    if (parsed.version === 1 && parsed.review) {
      parsed.context.fileHashes ??= {};
      return parsed;
    }
  } catch {
    // no cache
  }
  return undefined;
}

// Reconstruct the ReviewTarget recorded at save time (the cache stores only its
// kind string + base/head), so replayed output reports the right scope.
function targetFromCache(cached: CachedReview): ReviewTarget {
  const { target, base, head } = cached.context;
  switch (target) {
    case 'staged':
      return { kind: 'staged' };
    case 'branch':
      return { kind: 'branch', base: base ?? 'auto' };
    case 'commit':
      return { kind: 'commit', ref: head ?? 'HEAD' };
    case 'range':
      return { kind: 'range', range: head ?? 'HEAD' };
    default:
      return { kind: 'working' };
  }
}

// Rebuild a minimal DiffSet for re-rendering JSON output from a cached review.
export function diffSetFromCache(cached: CachedReview): DiffSet {
  return {
    files: cached.context.files.map((f) => ({
      path: f.path,
      status: f.status as DiffSet['files'][number]['status'],
      binary: false,
      hunks: [],
      additions: f.additions,
      deletions: f.deletions,
      language: f.language,
    })),
    target: targetFromCache(cached),
    base: cached.context.base,
    head: cached.context.head,
    totalAdditions: cached.context.files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: cached.context.files.reduce((n, f) => n + f.deletions, 0),
  };
}
