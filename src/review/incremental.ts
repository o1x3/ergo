import { createHash } from 'node:crypto';

import type { FileDiff } from '@/git/diff';
import { type CachedReview, computeDiffHashes } from '@/review/cache';
import type { ReviewProfile } from '@/review/prompts';
import {
  emptySeverityCounts,
  type Finding,
  type ReviewFinding,
  SEVERITY_RANK,
  type Severity,
} from '@/review/schema';

// Incremental reviews: when a file's rendered diff is byte-identical to what
// the last review saw, the model input for that file is identical — so its
// findings can be carried forward instead of re-paying for a fresh pass.
// Soundness rests on the diff hash (exact model input), not on refs or mtimes.

export type ReuseContext = {
  model: string;
  profile: ReviewProfile;
  minConfidence: number;
  promptFingerprint: string;
};

// Hash of every non-diff input that shapes findings. Two runs with the same
// per-file diff but different guidelines/learnings/focus/effort must NOT share
// findings — the model would have been asked a different question.
export function computePromptFingerprint(inputs: {
  guidelines?: string;
  learnings?: string;
  pathInstructions: unknown;
  customAgents: unknown;
  customFocus?: string;
  toneInstructions?: string;
  language?: string;
  reasoningEffort?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        inputs.guidelines ?? '',
        inputs.learnings ?? '',
        inputs.pathInstructions ?? [],
        inputs.customAgents ?? [],
        inputs.customFocus ?? '',
        inputs.toneInstructions ?? '',
        inputs.language ?? '',
        inputs.reasoningEffort ?? '',
      ]),
    )
    .digest('hex');
}

// Whether the cached review's findings are reusable under the current run's
// knobs. The cached run must have been produced by the same model, profile,
// and prompt context, and with a filter at least as permissive as the current
// one — otherwise the carried set could be missing findings the current run
// would have reported (or carrying findings biased by a different prompt).
export function canReuseCache(
  cached: CachedReview | undefined,
  ctx: ReuseContext,
): cached is CachedReview {
  if (!cached) return false;
  const c = cached.context;
  if (!c.diffHashes || Object.keys(c.diffHashes).length === 0) return false;
  if (c.profile !== ctx.profile) return false;
  if (c.minConfidence === undefined || c.minConfidence > ctx.minConfidence) {
    return false;
  }
  if (
    c.promptFingerprint === undefined ||
    c.promptFingerprint !== ctx.promptFingerprint
  ) {
    return false;
  }
  if (cached.review.stats.model !== ctx.model) return false;
  return true;
}

// Whether the cached review covered exactly the same file set as the current
// changeset. Required for reusing the cached SUMMARY — a summary describing
// files that left the changeset must not be replayed.
export function samePathSet(
  cached: CachedReview,
  files: ReadonlyArray<FileDiff>,
): boolean {
  const cachedPaths = new Set(cached.context.files.map((f) => f.path));
  if (cachedPaths.size !== files.length) return false;
  return files.every((f) => cachedPaths.has(f.path));
}

// Split the changeset into files whose rendered diff matches the cache
// (findings reusable) and files that need a fresh model pass.
export function partitionForIncremental(
  files: FileDiff[],
  cachedDiffHashes: Record<string, string>,
): { fresh: FileDiff[]; unchanged: FileDiff[] } {
  const current = computeDiffHashes(files);
  const fresh: FileDiff[] = [];
  const unchanged: FileDiff[] = [];
  for (const f of files) {
    if (cachedDiffHashes[f.path] === current[f.path]) unchanged.push(f);
    else fresh.push(f);
  }
  return { fresh, unchanged };
}

// Findings from the cached review that belong to unchanged files and clear the
// current confidence bar. IDs are stripped; merge re-assigns them.
export function carriedFindings(
  cached: CachedReview,
  unchangedPaths: ReadonlySet<string>,
  minConfidence: number,
): Finding[] {
  return cached.review.findings
    .filter((f) => unchangedPaths.has(f.file) && f.confidence >= minConfidence)
    .map(({ id: _id, ...rest }) => rest);
}

// Combine fresh + carried findings into one coherent result. Fresh findings
// KEEP their engine-assigned ids (in agent mode they were already streamed);
// carried findings continue the sequence. The combined list is re-sorted the
// way the engine sorts (severity, then confidence) for display.
export function mergeFindings(
  fresh: ReadonlyArray<ReviewFinding>,
  carried: ReadonlyArray<Finding>,
): ReviewFinding[] {
  const carriedWithIds: ReviewFinding[] = carried.map((f, i) => ({
    ...f,
    id: `ERG-${fresh.length + i + 1}`,
  }));
  return [...fresh, ...carriedWithIds].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.confidence - a.confidence,
  );
}

export function countBySeverity(
  findings: ReadonlyArray<Finding>,
): Record<Severity, number> {
  const counts = emptySeverityCounts();
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
