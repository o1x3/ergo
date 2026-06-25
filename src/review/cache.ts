import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DiffSet } from '@/git/diff';
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

export async function saveReviewCache(
  repoRoot: string,
  diff: DiffSet,
  review: ReviewResult,
): Promise<void> {
  const path = cachePath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
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
    if (parsed.version === 1 && parsed.review) return parsed;
  } catch {
    // no cache
  }
  return undefined;
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
    target: { kind: 'working' },
    base: cached.context.base,
    head: cached.context.head,
    totalAdditions: cached.context.files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: cached.context.files.reduce((n, f) => n + f.deletions, 0),
  };
}
