import { resolve as resolvePath } from 'node:path';

import { defineCommand } from 'citty';

import { runStaticAnalysis } from '@/analysis/runner';
import { getActiveCredential } from '@/auth/resolve';
import { makePathFilter } from '@/config/filters';
import { loadConfig } from '@/config/load';
import {
  collectDiff,
  type DiffSet,
  type FileDiff,
  type ReviewTarget,
} from '@/git/diff';
import { isGitRepo, repoRoot } from '@/git/repo';
import { resolveClient } from '@/inference/resolve';
import { loadLearningsForPrompt } from '@/memory/learnings';
import { recordUsage } from '@/memory/usage';
import { AgentEmitter } from '@/output/agent';
import { renderJson } from '@/output/json';
import { renderMarkdown } from '@/output/markdown';
import { renderSarif } from '@/output/sarif';
import { renderTerminal } from '@/output/terminal';
import { OUTPUT_FORMATS, type OutputFormat } from '@/output/types';
import {
  diffSetFromCache,
  loadReviewCache,
  saveReviewCache,
} from '@/review/cache';
import {
  gatherCustomAgents,
  gatherGuidelines,
  gatherPathInstructions,
} from '@/review/context';
import { type ReviewEvent, runReview } from '@/review/engine';
import { readInstructionFiles } from '@/review/instructions';
import type { PromptContext } from '@/review/prompts';
import {
  type ReviewResult,
  SEVERITIES,
  SEVERITY_RANK,
  type Severity,
} from '@/review/schema';
import { log, setQuiet } from '@/util/logger';

function resolveTarget(args: Record<string, unknown>): ReviewTarget {
  const commit = args.commit as string | undefined;
  const base = args.base as string | undefined;
  const baseCommit = args['base-commit'] as string | undefined;
  const type = (args.type as string | undefined) ?? 'all';

  if (commit) return { kind: 'commit', ref: commit };
  if (baseCommit) return { kind: 'range', range: `${baseCommit}..HEAD` };
  if (base) return { kind: 'branch', base };
  if (type === 'staged') return { kind: 'staged' };
  if (type === 'committed') return { kind: 'branch', base: 'auto' };
  // 'all' and 'uncommitted' both review the working tree vs HEAD.
  return { kind: 'working' };
}

function applyFileFilters(
  diff: DiffSet,
  config: ReturnTypeOfLoad,
  onlyFiles: string[] | undefined,
): { diff: DiffSet; skippedByFilter: number } {
  const pathFilter = makePathFilter(config.reviews.pathFilters);
  const ignoreFilter = makePathFilter(
    config.reviews.ignoreFiles.map((f: string) => `!${f}`),
  );
  const onlySet =
    onlyFiles && onlyFiles.length > 0 ? new Set(onlyFiles) : undefined;

  let skipped = 0;
  const files = diff.files.filter((f: FileDiff) => {
    if (onlySet && !onlySet.has(f.path)) return false;
    if (config.reviews.honorLinguistGenerated && f.isGenerated) {
      skipped += 1;
      return false;
    }
    if (!pathFilter(f.path) || !ignoreFilter(f.path)) {
      skipped += 1;
      return false;
    }
    return true;
  });

  return {
    diff: {
      ...diff,
      files,
      totalAdditions: files.reduce((n, f) => n + f.additions, 0),
      totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    skippedByFilter: skipped,
  };
}

type ReturnTypeOfLoad = Awaited<ReturnType<typeof loadConfig>>['config'];

// Prioritize highest-risk files when the changeset exceeds the file cap.
function applyFileLimit(diff: DiffSet, limit: number): DiffSet {
  if (limit <= 0 || diff.files.length <= limit) return diff;
  const ranked = [...diff.files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );
  const files = ranked.slice(0, limit);
  return { ...diff, files };
}

// `ergo review findings` / `ergo findings` — replay the last review from cache
// without re-running (and without spending tokens).
export const findingsCommand = defineCommand({
  meta: {
    name: 'findings',
    description: 'Replay the last review from cache (no re-run, no cost)',
  },
  args: {
    format: {
      type: 'string',
      description: `Output: ${OUTPUT_FORMATS.join(' | ')}`,
    },
    dir: { type: 'string', description: 'Path to the git repo' },
  },
  async run({ args }) {
    const cwd = args.dir ? resolvePath(args.dir as string) : process.cwd();
    const root = (await isGitRepo(cwd)) ? await repoRoot(cwd) : cwd;
    const cached = await loadReviewCache(root);
    if (!cached) {
      log.error('No cached review found. Run `ergo review` first.');
      process.exitCode = 1;
      return;
    }
    const format = normalizeFormat(args.format as string | undefined);
    log.dim(`replaying review from ${cached.savedAt}`);
    emitOutput(format, cached.review, diffSetFromCache(cached), undefined);
  },
});

export const reviewCommand = defineCommand({
  meta: {
    name: 'review',
    description: 'Review local changes with AI (the default command)',
  },
  args: {
    type: {
      type: 'string',
      alias: 't',
      description: 'Scope: all | committed | uncommitted | staged',
    },
    base: {
      type: 'string',
      description: 'Review this branch against a base branch (e.g. main)',
    },
    'base-commit': {
      type: 'string',
      description: 'Compare against a specific commit',
    },
    commit: {
      type: 'string',
      alias: 'c',
      description: 'Review a single commit (e.g. HEAD~1)',
    },
    dir: { type: 'string', description: 'Path to the git repo to review' },
    files: {
      type: 'string',
      alias: 'f',
      description: 'Comma-separated list of files to review',
    },
    prompt: {
      type: 'string',
      alias: 'p',
      description:
        'Extra focus for this review (e.g. "check for SQL injection")',
    },
    instructions: {
      type: 'string',
      description: 'Comma-separated instruction files to layer onto the review',
    },
    format: {
      type: 'string',
      description: `Output: ${OUTPUT_FORMATS.join(' | ')}`,
    },
    model: { type: 'string', alias: 'm', description: 'Override the model' },
    profile: {
      type: 'string',
      description: 'Review profile: chill | assertive',
    },
    light: {
      type: 'boolean',
      description: 'Faster, cheaper review (triage model)',
    },
    fast: { type: 'boolean', description: 'Alias for --light' },
    deep: {
      type: 'boolean',
      description: 'Deeper review with the strongest configured model',
    },
    ultra: { type: 'boolean', description: 'Alias for --deep' },
    'min-confidence': {
      type: 'string',
      description: 'Only report findings at/above this confidence (0-1)',
    },
    'no-summary': { type: 'boolean', description: 'Skip the summary pass' },
    'no-static': {
      type: 'boolean',
      description: 'Skip bundled static-analysis grounding',
    },
    'fail-on': {
      type: 'string',
      description: `Exit non-zero if any finding >= severity (${SEVERITIES.join('|')})`,
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      description: 'Suppress progress output',
    },
  },
  async run({ args }) {
    const format = normalizeFormat(args.format as string | undefined);
    const machine =
      format === 'agent' || format === 'json' || format === 'sarif';
    if (args.quiet || machine) setQuiet(true);

    const cwd = args.dir ? resolvePath(args.dir as string) : process.cwd();
    if (!(await isGitRepo(cwd))) {
      log.error(
        `Not a git repository: ${cwd}. ergo reviews git changes — run it inside a repo.`,
      );
      process.exitCode = 1;
      return;
    }
    const root = await repoRoot(cwd);

    const { config, errors: configErrors } = await loadConfig(root);
    for (const e of configErrors) log.warn(`config: ${e}`);

    // Resolve provider/model.
    let credential: Awaited<ReturnType<typeof getActiveCredential>>;
    try {
      credential = await getActiveCredential();
    } catch (err) {
      handleFatal(err, format);
      process.exitCode = 1;
      return;
    }

    const isFast = Boolean(args.light || args.fast);
    const isDeep = Boolean(args.deep || args.ultra);
    const modelOverride =
      (args.model as string | undefined) ??
      (isDeep
        ? config.model.deep
        : isFast
          ? config.model.triage
          : config.model.default);
    const resolved = resolveClient({
      credential,
      modelOverride,
      fast: isFast,
      sessionId: `ergo-${Date.now()}`,
    });
    if (resolved.fallbackFrom) {
      log.warn(
        `Model '${resolved.fallbackFrom}' isn't available on this account; using '${resolved.model}'.`,
      );
    }

    // Collect + filter the diff.
    const target = resolveTarget(args);
    let diff: DiffSet;
    try {
      diff = await collectDiff(target, { cwd: root });
    } catch (err) {
      handleFatal(err, format);
      process.exitCode = 1;
      return;
    }

    const onlyFiles = (args.files as string | undefined)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const { diff: filtered, skippedByFilter } = applyFileFilters(
      diff,
      config,
      onlyFiles,
    );
    const limit = isDeep
      ? config.reviews.ultraFileLimit
      : config.reviews.fileLimit;
    const finalDiff = applyFileLimit(filtered, limit);

    if (finalDiff.files.length === 0) {
      if (format === 'agent') {
        const emitter = new AgentEmitter();
        emitter.reviewContext(finalDiff, root);
        emitter.complete({
          findingsBySeverity: {
            critical: 0,
            major: 0,
            minor: 0,
            suggestion: 0,
            info: 0,
          },
        } as never);
      } else if (format === 'json') {
        process.stdout.write(
          `${renderJson({ summary: emptySummary(), findings: [], stats: emptyStats(resolved) }, finalDiff)}\n`,
        );
      } else {
        log.info('No changes to review.');
      }
      return;
    }

    // Build prompt context.
    const minConfidence = args['min-confidence']
      ? Number(args['min-confidence'])
      : config.reviews.minConfidence;
    const profile =
      (args.profile as 'chill' | 'assertive' | undefined) ??
      config.reviews.profile;

    const [guidelines, learnings, instructionFiles] = await Promise.all([
      gatherGuidelines(root, config),
      config.knowledgeBase.optOut
        ? Promise.resolve(undefined)
        : loadLearningsForPrompt(root, config.knowledgeBase.learningsScope),
      readInstructionFiles(
        root,
        (args.instructions as string | undefined)
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      ),
    ]);
    const pathInstructions = gatherPathInstructions(finalDiff, config);
    const customAgents = gatherCustomAgents(finalDiff, config);

    // Static-analysis grounding: run installed linters on changed lines and feed
    // their findings to the model to verify/dedupe/prioritize.
    const analysis = await runStaticAnalysis(finalDiff, {
      repoRoot: root,
      toggles: config.reviews.tools,
      enabled: !args['no-static'],
    });
    if (analysis.ran.length > 0) {
      log.dim(`static analysis: ${analysis.ran.join(', ')}`);
    }

    const customFocusParts = [
      args.prompt as string | undefined,
      instructionFiles,
      customAgents,
    ].filter(Boolean);

    const promptContext: PromptContext = {
      profile,
      minConfidence,
      customFocus: customFocusParts.length
        ? customFocusParts.join('\n\n')
        : undefined,
      guidelines,
      pathInstructions,
      learnings,
      staticFindings: analysis.groundingText,
      language: config.language,
      toneInstructions: config.toneInstructions,
    };

    // Run the review.
    const agentEmitter = format === 'agent' ? new AgentEmitter() : undefined;
    if (agentEmitter) agentEmitter.reviewContext(finalDiff, root);

    const onEvent = (event: ReviewEvent) => {
      if (agentEmitter) {
        agentEmitter.onReviewEvent(event);
        return;
      }
      if (event.type === 'status') {
        const labels: Record<string, string> = {
          setup: 'Preparing review…',
          analyzing: 'Analyzing changes…',
          reviewing: `Reviewing with ${resolved.model}…`,
          summarizing: 'Summarizing…',
          completed: 'Done.',
        };
        const label = labels[event.phase];
        if (label) log.step(label);
      }
    };

    let review: ReviewResult;
    try {
      review = await runReview({
        diff: finalDiff,
        resolved,
        promptContext,
        generateSummary: !args['no-summary'] && config.reviews.highLevelSummary,
        reasoningEffort: isDeep
          ? 'high'
          : isFast
            ? 'low'
            : config.model.reasoningEffort,
        onEvent,
      });
    } catch (err) {
      if (agentEmitter) {
        agentEmitter.error(
          'review',
          err instanceof Error ? err.message : String(err),
          false,
        );
      } else {
        handleFatal(err, format);
      }
      process.exitCode = 1;
      return;
    }

    if (skippedByFilter > 0) {
      review.stats.filesSkipped += skippedByFilter;
    }

    // Persist for `ergo review findings` replay and `ergo fix`; log usage.
    await saveReviewCache(root, finalDiff, review).catch(() => {});
    await recordUsage(root, review.stats).catch(() => {});

    // Emit output.
    emitOutput(format, review, finalDiff, agentEmitter);

    // Exit code policy.
    const failOn = args['fail-on'] as Severity | undefined;
    if (failOn && SEVERITY_RANK[failOn]) {
      const worst = review.findings.reduce(
        (max, f) => Math.max(max, SEVERITY_RANK[f.severity]),
        0,
      );
      if (worst >= SEVERITY_RANK[failOn]) {
        process.exitCode = 2;
      }
    }
  },
});

function emitOutput(
  format: OutputFormat,
  review: ReviewResult,
  diff: DiffSet,
  agentEmitter: AgentEmitter | undefined,
): void {
  switch (format) {
    case 'agent':
      agentEmitter?.complete(review.stats);
      break;
    case 'json':
      process.stdout.write(`${renderJson(review, diff)}\n`);
      break;
    case 'sarif':
      process.stdout.write(`${renderSarif(review)}\n`);
      break;
    case 'markdown':
      process.stdout.write(`${renderMarkdown(review, diff)}\n`);
      break;
    case 'plain':
      process.stdout.write(`${renderTerminal(review, { plain: true })}\n`);
      break;
    default:
      process.stdout.write(`${renderTerminal(review)}\n`);
  }
}

function normalizeFormat(format: string | undefined): OutputFormat {
  if (!format) return 'pretty';
  const f = format.toLowerCase();
  if (f === 'ndjson') return 'agent';
  if (f === 'md') return 'markdown';
  if (OUTPUT_FORMATS.includes(f as OutputFormat)) return f as OutputFormat;
  return 'pretty';
}

function handleFatal(err: unknown, _format: OutputFormat): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
}

function emptySummary() {
  return {
    summary: 'No changes to review.',
    walkthrough: '',
    fileSummaries: [],
    effort: 1,
    mergeConfidence: 5,
    sequenceDiagram: undefined,
  };
}

function emptyStats(resolved: ReturnType<typeof resolveClient>) {
  return {
    filesReviewed: 0,
    filesSkipped: 0,
    additions: 0,
    deletions: 0,
    findingsBySeverity: {
      critical: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
      info: 0,
    },
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    subscriptionCovered: resolved.subscription,
    model: resolved.model,
    provider: resolved.provider,
    durationMs: 0,
  };
}
