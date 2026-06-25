import type { DiffSet, FileDiff } from '@/git/diff';
import { estimateCostUsd } from '@/inference/models';
import type { ResolvedClient } from '@/inference/resolve';
import { completeStructured } from '@/inference/structured';
import type { ModelUsage } from '@/inference/types';
import {
  findingsSystemPrompt,
  findingsUserPrompt,
  type PromptContext,
  summarySystemPrompt,
  summaryUserPrompt,
} from '@/review/prompts';
import {
  emptySeverityCounts,
  FINDINGS_JSON_SCHEMA,
  type Finding,
  findingsResultSchema,
  type ReviewFinding,
  type ReviewResult,
  type ReviewStats,
  SEVERITY_RANK,
  type Severity,
  SUMMARY_JSON_SCHEMA,
  type SummaryResult,
  summaryResultSchema,
} from '@/review/schema';
import { renderFileDiff, serializeDiffSet } from '@/review/serialize';

export type ReviewEvent =
  | { type: 'status'; phase: ReviewPhase; detail?: string }
  | { type: 'finding'; finding: ReviewFinding }
  | { type: 'summary'; summary: SummaryResult }
  | { type: 'tool_skipped'; name: string; reason: string };

export type ReviewPhase =
  | 'setup'
  | 'analyzing'
  | 'reviewing'
  | 'summarizing'
  | 'completed';

export type RunReviewOptions = {
  diff: DiffSet;
  resolved: ResolvedClient;
  promptContext: PromptContext;
  // Filtering / shaping
  includeFinding?: (f: Finding) => boolean;
  generateSummary?: boolean;
  perBatchChars?: number;
  maxConcurrency?: number;
  reasoningEffort?: ReasoningEffortLevel;
  onEvent?: (event: ReviewEvent) => void;
  signal?: AbortSignal;
};

type ReasoningEffortLevel = 'minimal' | 'low' | 'medium' | 'high';

function maxNewLine(file: FileDiff): number {
  let max = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.newLine && l.newLine > max) max = l.newLine;
    }
  }
  return max;
}

// Greedily pack rendered file diffs into batches under a char budget so each
// findings pass stays within a sane context window.
function batchFiles(files: FileDiff[], perBatchChars: number): FileDiff[][] {
  const batches: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let used = 0;
  for (const file of files) {
    const size = renderFileDiff(file).length;
    if (used + size > perBatchChars && current.length > 0) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(file);
    used += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function combineUsage(
  a: ModelUsage | undefined,
  b: ModelUsage | undefined,
): ModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    estimated: a.estimated || b.estimated,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i] as T, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// Clamp a finding's line range to the file's real new-line bounds and dedupe.
function normalizeFinding(
  f: Finding,
  fileByPath: Map<string, FileDiff>,
): Finding {
  const file = fileByPath.get(f.file);
  let { startLine, endLine } = f;
  if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
  if (file) {
    const max = maxNewLine(file);
    if (max > 0) {
      startLine = Math.min(Math.max(1, startLine), max);
      endLine = Math.min(Math.max(startLine, endLine), max);
    }
  }
  return { ...f, startLine, endLine };
}

function dedupeKey(f: Finding): string {
  const title = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${f.file}:${f.startLine}:${title.slice(0, 40)}`;
}

export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const start = Date.now();
  const { diff, resolved, promptContext } = opts;
  const emit = opts.onEvent ?? (() => {});
  const perBatch = opts.perBatchChars ?? 120_000;
  const concurrency = opts.maxConcurrency ?? 4;

  emit({ type: 'status', phase: 'setup' });

  const serialized = serializeDiffSet(diff, { maxChars: 5_000_000 });
  const reviewable = serialized.includedFiles.filter(
    (f) => !f.binary && f.hunks.length > 0,
  );
  const fileByPath = new Map(diff.files.map((f) => [f.path, f]));

  emit({ type: 'status', phase: 'analyzing' });

  const batches = batchFiles(reviewable, perBatch);
  let usage: ModelUsage | undefined;

  emit({ type: 'status', phase: 'reviewing' });

  // Findings passes (one per batch), bounded concurrency.
  const sysFindings = findingsSystemPrompt(promptContext);
  const rawFindings: Finding[] = [];
  await mapLimit(batches, concurrency, async (batch) => {
    const batchDiff: DiffSet = { ...diff, files: batch };
    const text = batch.map(renderFileDiff).join('\n\n');
    const user = findingsUserPrompt(batchDiff, text, promptContext);
    const result = await completeStructured({
      client: resolved.client,
      model: resolved.model,
      schema: findingsResultSchema,
      jsonSchema: FINDINGS_JSON_SCHEMA,
      system: sysFindings,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1,
      reasoningEffort: opts.reasoningEffort,
      signal: opts.signal,
    });
    usage = combineUsage(usage, result.usage);
    for (const f of result.value.findings) rawFindings.push(f);
  });

  // Summary pass (parallelizable but cheap; run after to reuse the same client).
  let summary: SummaryResult;
  if (opts.generateSummary !== false) {
    emit({ type: 'status', phase: 'summarizing' });
    const text = serializeDiffSet(diff, { maxChars: perBatch }).text;
    try {
      const result = await completeStructured({
        client: resolved.client,
        model: resolved.model,
        schema: summaryResultSchema,
        jsonSchema: SUMMARY_JSON_SCHEMA,
        system: summarySystemPrompt(promptContext),
        messages: [
          {
            role: 'user',
            content: summaryUserPrompt(diff, text, promptContext),
          },
        ],
        temperature: 0.2,
        reasoningEffort: opts.reasoningEffort,
        signal: opts.signal,
      });
      usage = combineUsage(usage, result.usage);
      summary = result.value;
      emit({ type: 'summary', summary });
    } catch {
      summary = fallbackSummary(diff);
    }
  } else {
    summary = fallbackSummary(diff);
  }

  // Post-process findings: normalize, confidence/path filter, dedupe, sort.
  const include = opts.includeFinding ?? (() => true);
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];
  const normalized = rawFindings
    .map((f) => normalizeFinding(f, fileByPath))
    .filter(
      (f) =>
        f.confidence >= promptContext.minConfidence &&
        fileByPath.has(f.file) &&
        include(f),
    )
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.confidence - a.confidence,
    );

  let counter = 0;
  for (const f of normalized) {
    const key = dedupeKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    counter += 1;
    const withId: ReviewFinding = { ...f, id: `ERG-${counter}` };
    findings.push(withId);
    emit({ type: 'finding', finding: withId });
  }

  const findingsBySeverity = emptySeverityCounts();
  for (const f of findings) findingsBySeverity[f.severity as Severity] += 1;

  const stats: ReviewStats = {
    filesReviewed: reviewable.length,
    filesSkipped: diff.files.length - reviewable.length,
    additions: diff.totalAdditions,
    deletions: diff.totalDeletions,
    findingsBySeverity,
    tokensInput: usage?.input ?? 0,
    tokensOutput: usage?.output ?? 0,
    costUsd: resolved.subscription ? 0 : estimateCostUsd(resolved.model, usage),
    subscriptionCovered: resolved.subscription,
    model: resolved.model,
    provider: resolved.provider,
    durationMs: Date.now() - start,
  };

  emit({ type: 'status', phase: 'completed' });

  return { summary, findings, stats };
}

function fallbackSummary(diff: DiffSet): SummaryResult {
  return {
    summary: `${diff.files.length} file(s) changed (+${diff.totalAdditions}/-${diff.totalDeletions}).`,
    walkthrough: '',
    fileSummaries: diff.files.map((f) => ({
      path: f.path,
      summary: `${f.status} (+${f.additions}/-${f.deletions})`,
    })),
    effort: Math.min(5, Math.max(1, Math.ceil(diff.files.length / 5))),
    mergeConfidence: 3,
    sequenceDiagram: undefined,
  };
}
