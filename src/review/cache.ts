import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DiffSet, ReviewTarget } from '@/git/diff';
import type { ReviewProfile } from '@/review/prompts';
import type { ReviewResult } from '@/review/schema';
import { renderFileDiff } from '@/review/serialize';
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
    // sha256 of each file's RENDERED DIFF at review time. If a file's rendered
    // diff is byte-identical on the next run, the model input for that file is
    // identical, so its findings can be reused (incremental reviews).
    diffHashes?: Record<string, string>;
    // Review knobs the findings were produced under; incremental reuse is only
    // sound when they are compatible with the current run.
    profile?: ReviewProfile;
    minConfidence?: number;
    // Hash of every non-diff input that shapes findings (guidelines, learnings,
    // path instructions, custom agents, per-run focus, tone, language,
    // reasoning effort). Reuse requires an exact match.
    promptFingerprint?: string;
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

// Per-file hash of the rendered diff — the exact text the model reviews.
export function computeDiffHashes(
  files: DiffSet['files'],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f.path] = hashContent(renderFileDiff(f));
  return hashes;
}

export async function saveReviewCache(
  repoRoot: string,
  diff: DiffSet,
  review: ReviewResult,
  meta: {
    profile?: ReviewProfile;
    minConfidence?: number;
    promptFingerprint?: string;
  } = {},
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
  // Never record a diff hash for a file whose findings batch failed — the
  // model didn't review it, and a recorded hash would let the next incremental
  // run carry forward "no findings" for coverage that never existed.
  const diffHashes = computeDiffHashes(diff.files);
  for (const p of review.stats.unreviewedFiles ?? []) delete diffHashes[p];
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
      diffHashes,
      profile: meta.profile,
      minConfidence: meta.minConfidence,
      promptFingerprint: meta.promptFingerprint,
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
    case 'all':
      return { kind: 'all', base: base ?? 'auto' };
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
