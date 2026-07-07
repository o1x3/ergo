import { resolve as resolvePath } from 'node:path';

import { defineCommand } from 'citty';

import { runStaticAnalysis } from '@/analysis/runner';
import { getActiveCredential } from '@/auth/resolve';
import { makePathFilter, matchesAny } from '@/config/filters';
import { loadConfig } from '@/config/load';
import {
  collectDiff,
  type DiffSet,
  type FileDiff,
  type ReviewTarget,
} from '@/git/diff';
import { commitMeta, currentBranch, isGitRepo, repoRoot } from '@/git/repo';
import { estimateCostUsd } from '@/inference/models';
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
  gatherFullFileContext,
  gatherGuidelines,
  gatherHistoryContext,
  gatherPathInstructions,
} from '@/review/context';
import { type ReviewEvent, runReview } from '@/review/engine';
import {
  canReuseCache,
  carriedFindings,
  computePromptFingerprint,
  countBySeverity,
  mergeFindings,
  partitionForIncremental,
  samePathSet,
} from '@/review/incremental';
import { readInstructionFiles } from '@/review/instructions';
import type { PromptContext } from '@/review/prompts';
import {
  type Finding,
  type ReviewResult,
  SEVERITIES,
  SEVERITY_RANK,
  type Severity,
} from '@/review/schema';
import { serializeDiffSet } from '@/review/serialize';
import { commandExists, exec } from '@/util/exec';
import { log, setColorMode, setQuiet } from '@/util/logger';

function resolveTarget(args: Record<string, unknown>): ReviewTarget {
  const commit = args.commit as string | undefined;
  const base = args.base as string | undefined;
  const baseCommit = args['base-commit'] as string | undefined;
  const type = args.type as string | undefined;

  if (commit) return { kind: 'commit', ref: commit };
  if (baseCommit) return { kind: 'range', range: `${baseCommit}..HEAD` };
  if (base) return { kind: 'branch', base };
  if (type === 'staged') return { kind: 'staged' };
  if (type === 'committed') return { kind: 'branch', base: 'auto' };
  // Explicit --type all: everything since the fork point — committed work vs
  // the auto-detected base PLUS the working tree.
  if (type === 'all') return { kind: 'all', base: 'auto' };
  // Default (and 'uncommitted'): the working tree vs HEAD.
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
function applyFileLimit(
  diff: DiffSet,
  limit: number,
): { diff: DiffSet; dropped: number } {
  if (limit <= 0 || diff.files.length <= limit) {
    return { diff, dropped: 0 };
  }
  const ranked = [...diff.files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );
  const files = ranked.slice(0, limit);
  return {
    diff: {
      ...diff,
      files,
      totalAdditions: files.reduce((n, f) => n + f.additions, 0),
      totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    dropped: diff.files.length - files.length,
  };
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
    // --format wins, else the configured default (same policy as `review`).
    const { config } = await loadConfig(root);
    setColorMode(config.output.color);
    const formatInput =
      (args.format as string | undefined) ?? config.output.defaultFormat;
    const format = normalizeFormat(formatInput);
    if (format === null) {
      log.error(
        `Invalid --format '${formatInput}'. Use one of: ${OUTPUT_FORMATS.join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }
    if (format === 'agent' || format === 'json' || format === 'sarif') {
      setQuiet(true);
    }
    log.dim(`replaying review from ${cached.savedAt}`);
    const diff = diffSetFromCache(cached);
    if (format === 'agent') {
      // Replay the full NDJSON stream (an emitter-less emitOutput would write
      // nothing at all for this format).
      const emitter = new AgentEmitter();
      emitter.reviewContext(diff, root);
      for (const f of cached.review.findings) {
        emitter.onReviewEvent({ type: 'finding', finding: f });
      }
      emitter.complete(cached.review.stats);
      return;
    }
    emitOutput(format, cached.review, diff, undefined, {
      diagrams: config.output.markdownDiagrams,
      effort: config.reviews.estimateEffort,
      mergeConfidence: config.reviews.mergeConfidence,
      aiPrompts: config.reviews.promptForAiAgents,
    });
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
      description:
        'Scope: all (committed vs base + working tree) | committed (branch vs base) | uncommitted (working tree vs HEAD, the default) | staged (index only)',
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
    full: {
      type: 'boolean',
      description:
        'Force a full review (skip incremental reuse of unchanged files)',
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
    budget: {
      type: 'string',
      description:
        'Abort if the estimated API cost would exceed this USD amount',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      description: 'Suppress progress output',
    },
  },
  async run({ args }) {
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
    setColorMode(config.output.color);
    if (config.raw.knowledge_base?.web_search?.enabled) {
      log.warn(
        'knowledge_base.web_search is not supported by ergo (no web-search backend); ignoring.',
      );
    }

    // Effective output format: --format wins, else the configured default.
    const formatInput =
      (args.format as string | undefined) ?? config.output.defaultFormat;
    const format = normalizeFormat(formatInput);
    if (format === null) {
      log.error(
        `Invalid --format '${formatInput}'. Use one of: ${OUTPUT_FORMATS.join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }
    const machine =
      format === 'agent' || format === 'json' || format === 'sarif';
    if (args.quiet || machine) setQuiet(true);

    // Validate --fail-on early so a typo can't silently disable a CI gate.
    // Case-insensitive: `--fail-on Major` means major.
    const failOn = (args['fail-on'] as string | undefined)?.toLowerCase() as
      | Severity
      | undefined;
    if (failOn !== undefined && !SEVERITIES.includes(failOn)) {
      log.error(
        `Invalid --fail-on '${failOn}'. Use one of: ${SEVERITIES.join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }

    // Validate --type so a typo doesn't silently fall back to the working tree.
    const typeArg = args.type as string | undefined;
    if (
      typeArg !== undefined &&
      !['all', 'committed', 'uncommitted', 'staged'].includes(typeArg)
    ) {
      log.error(
        `Invalid --type '${typeArg}'. Use all | committed | uncommitted | staged.`,
      );
      process.exitCode = 1;
      return;
    }

    // Conflicting target flags must error, not resolve by silent precedence —
    // `--type staged --commit HEAD` reviewing the commit would surprise.
    const targetFlags = [
      args.commit ? '--commit' : undefined,
      args['base-commit'] ? '--base-commit' : undefined,
      args.base ? '--base' : undefined,
      typeArg !== undefined ? '--type' : undefined,
    ].filter((f): f is string => Boolean(f));
    if (targetFlags.length > 1) {
      log.error(
        `Conflicting review-target flags: ${targetFlags.join(' + ')}. Pass only one of --commit, --base-commit, --base, --type.`,
      );
      process.exitCode = 1;
      return;
    }

    // Policy skips that need no credential: emit a well-formed empty result
    // for machine formats (a warn alone would leave json/sarif pipes empty).
    const emitPolicySkip = (reason: string) => {
      log.warn(reason);
      const emptyDiff: DiffSet = {
        files: [],
        target: resolveTarget(args),
        totalAdditions: 0,
        totalDeletions: 0,
      };
      const review: ReviewResult = {
        summary: emptySummary(),
        findings: [],
        stats: emptyStats('', '', false),
      };
      if (format === 'agent') {
        const emitter = new AgentEmitter();
        emitter.reviewContext(emptyDiff, root);
        emitter.complete(review.stats);
      } else if (format !== 'pretty' && format !== 'plain') {
        emitOutput(format, review, emptyDiff, undefined);
      }
    };

    // reviews.enabled: false — the repo has opted out (e.g. a repo-wide git
    // hook rollout with per-repo opt-out). Skip without requiring a credential.
    if (!config.reviews.enabled) {
      emitPolicySkip(
        'Skipping review: disabled by config (reviews.enabled: false).',
      );
      return;
    }

    // reviews.ignore.head_branches / base_branches: skip when the current
    // branch (or the requested base) matches an ignore glob.
    if (config.reviews.ignoreHeadBranches.length > 0) {
      const branch = await currentBranch(root).catch(() => undefined);
      if (branch && matchesAny(branch, config.reviews.ignoreHeadBranches)) {
        emitPolicySkip(
          `Skipping review: branch '${branch}' matches reviews.ignore.head_branches.`,
        );
        return;
      }
    }
    const baseArg = args.base as string | undefined;
    if (
      baseArg &&
      config.reviews.ignoreBaseBranches.length > 0 &&
      matchesAny(baseArg, config.reviews.ignoreBaseBranches)
    ) {
      emitPolicySkip(
        `Skipping review: base '${baseArg}' matches reviews.ignore.base_branches.`,
      );
      return;
    }

    // Resolve provider/model.
    let credential: Awaited<ReturnType<typeof getActiveCredential>>;
    try {
      credential = await getActiveCredential();
    } catch (err) {
      handleFatal(err, format, 'auth');
      process.exitCode = 1;
      return;
    }

    const isFast = Boolean(args.light || args.fast);
    const isDeep = Boolean(args.deep || args.ultra);
    if (isFast && isDeep) {
      log.error('--light/--fast and --deep/--ultra are mutually exclusive.');
      process.exitCode = 1;
      return;
    }
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
    // model.provider is derived from the credential, not the config — surface
    // a mismatch instead of silently ignoring the configured value.
    if (
      config.model.provider &&
      config.model.provider !== resolved.provider &&
      !(config.model.provider === 'codex' && credential.provider === 'codex')
    ) {
      log.warn(
        `config sets model.provider '${config.model.provider}' but the active credential is '${resolved.provider}'; the credential wins. Run \`ergo auth login\` to switch providers.`,
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

    // An auto-detected base (`--type committed` / `--type all`) is only known
    // after collection — apply reviews.ignore.base_branches to it here. Match
    // both the resolved ref ('origin/main') and its short name ('main').
    if (
      (target.kind === 'branch' || target.kind === 'all') &&
      diff.base &&
      config.reviews.ignoreBaseBranches.length > 0 &&
      (matchesAny(diff.base, config.reviews.ignoreBaseBranches) ||
        matchesAny(
          diff.base.replace(/^origin\//, ''),
          config.reviews.ignoreBaseBranches,
        ))
    ) {
      emitPolicySkip(
        `Skipping review: base '${diff.base}' matches reviews.ignore.base_branches.`,
      );
      return;
    }

    // reviews.ignore.pr_titles / ignore_usernames — local analog: the head
    // commit's subject and author (commit-bearing targets only).
    if (
      (target.kind === 'commit' ||
        target.kind === 'branch' ||
        target.kind === 'all' ||
        target.kind === 'range') &&
      (config.reviews.ignorePrTitles.length > 0 ||
        config.reviews.ignoreUsernames.length > 0)
    ) {
      const ref = target.kind === 'commit' ? target.ref : 'HEAD';
      const meta = await commitMeta(ref, root);
      if (meta) {
        const titleHit = config.reviews.ignorePrTitles.find((p) =>
          matchesTitlePattern(meta.subject, p),
        );
        if (titleHit) {
          emitPolicySkip(
            `Skipping review: commit subject matches reviews.ignore.pr_titles ('${titleHit}').`,
          );
          return;
        }
        if (
          matchesAny(meta.authorName, config.reviews.ignoreUsernames) ||
          matchesAny(meta.authorEmail, config.reviews.ignoreUsernames)
        ) {
          emitPolicySkip(
            `Skipping review: author '${meta.authorName}' matches reviews.ignore.ignore_usernames.`,
          );
          return;
        }
      }
    }

    // reviews.ignore.pr_labels — when the branch has an open PR and the gh CLI
    // is available, honor its labels. Best-effort: any failure means no skip.
    if (
      (target.kind === 'branch' || target.kind === 'all') &&
      config.reviews.ignorePrLabels.length > 0 &&
      (await commandExists('gh'))
    ) {
      const { stdout, exitCode } = await exec(
        ['gh', 'pr', 'view', '--json', 'labels', '--jq', '.labels[].name'],
        { cwd: root },
      );
      if (exitCode === 0) {
        const labels = stdout.split('\n').filter(Boolean);
        const hit = labels.find((l) =>
          matchesAny(l, config.reviews.ignorePrLabels),
        );
        if (hit) {
          emitPolicySkip(
            `Skipping review: PR label '${hit}' matches reviews.ignore.pr_labels.`,
          );
          return;
        }
      }
    }

    // Normalize `./src/x.ts` → `src/x.ts` so --files matches git's paths.
    const onlyFiles = (args.files as string | undefined)
      ?.split(',')
      .map((s) => s.trim().replace(/^\.\//, ''))
      .filter(Boolean);
    const { diff: filtered, skippedByFilter } = applyFileFilters(
      diff,
      config,
      onlyFiles,
    );
    // Emit a well-formed "nothing reviewed" result for every format, so machine
    // consumers (json/sarif pipelines) never receive an empty stream.
    const emitNothingReviewed = (diffForContext: DiffSet, note: string) => {
      const emptyReview: ReviewResult = {
        summary: emptySummary(),
        findings: [],
        stats: emptyStats(
          resolved.model,
          resolved.provider,
          resolved.subscription,
        ),
      };
      if (format === 'agent') {
        const emitter = new AgentEmitter();
        emitter.reviewContext(diffForContext, root);
        emitter.complete(emptyReview.stats);
      } else if (format === 'pretty' || format === 'plain') {
        // Human formats: a short message is friendlier than an empty report.
        log.info(note);
      } else {
        emitOutput(format, emptyReview, diffForContext, undefined);
      }
    };

    // reviews.ignore.max_changed_lines: skip the review entirely when the
    // changeset is bigger than the configured cap (0 = no cap).
    const maxLines = config.reviews.maxChangedLines;
    const changedLines = filtered.totalAdditions + filtered.totalDeletions;
    if (maxLines > 0 && changedLines > maxLines) {
      log.warn(
        `Skipping review: ${changedLines} changed line(s) exceeds reviews.ignore.max_changed_lines (${maxLines}).`,
      );
      emitNothingReviewed({ ...filtered, files: [] }, 'Review skipped.');
      return;
    }

    const limit = isDeep
      ? config.reviews.ultraFileLimit
      : config.reviews.fileLimit;
    const { diff: finalDiff, dropped: droppedByLimit } = applyFileLimit(
      filtered,
      limit,
    );
    if (droppedByLimit > 0) {
      log.warn(
        `${droppedByLimit} lower-risk file(s) skipped (over the ${limit}-file cap; raise with reviews.file_limit or --deep).`,
      );
    }

    if (finalDiff.files.length === 0) {
      emitNothingReviewed(finalDiff, 'No changes to review.');
      return;
    }

    // Review knobs (needed before the incremental partition).
    let minConfidence = config.reviews.minConfidence;
    if (args['min-confidence'] !== undefined) {
      const n = Number(args['min-confidence']);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        log.error(
          `Invalid --min-confidence '${args['min-confidence']}'. Use a number in [0, 1].`,
        );
        process.exitCode = 1;
        return;
      }
      minConfidence = n;
    }
    const profile =
      (args.profile as 'chill' | 'assertive' | undefined) ??
      config.reviews.profile;
    if (!['chill', 'assertive'].includes(profile)) {
      log.error(`Invalid --profile '${profile}'. Use chill | assertive.`);
      process.exitCode = 1;
      return;
    }

    // Validate --budget up front so a typo'd value fails on every path
    // (including the zero-spend fast path below).
    const budget =
      args.budget !== undefined
        ? Number(args.budget)
        : config.model.maxBudgetUsd;
    if (args.budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
      log.error(
        `Invalid --budget '${args.budget}'. Use a non-negative number.`,
      );
      process.exitCode = 1;
      return;
    }

    // Non-diff prompt inputs — gathered before the incremental partition so
    // they can be fingerprinted: findings reuse is only sound when the model
    // would have been asked the exact same question.
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
    // reviews.whole_repo_context / history_context — extra prompt context.
    // Full files are worktree reads, so only for working-tree-safe targets.
    const worktreeSafe =
      target.kind === 'working' ||
      target.kind === 'staged' ||
      target.kind === 'all' ||
      target.kind === 'branch';
    const fullFiles =
      config.reviews.wholeRepoContext && worktreeSafe
        ? await gatherFullFileContext(root, finalDiff.files)
        : undefined;
    const history = config.reviews.historyContext
      ? await gatherHistoryContext(root, finalDiff.files)
      : undefined;
    const customFocusParts = [
      args.prompt as string | undefined,
      instructionFiles,
      customAgents,
    ].filter(Boolean);
    const customFocus = customFocusParts.length
      ? customFocusParts.join('\n\n')
      : undefined;
    const reasoningEffort = isDeep
      ? 'high'
      : isFast
        ? 'low'
        : config.model.reasoningEffort;
    const promptFingerprint = computePromptFingerprint({
      guidelines,
      learnings,
      pathInstructions,
      customAgents,
      customFocus,
      toneInstructions: config.toneInstructions,
      language: config.language,
      reasoningEffort,
      wholeRepoContext: Boolean(fullFiles),
      history,
    });

    // Incremental reuse: files whose rendered diff is byte-identical to the
    // last review — under an identical prompt context — carry their findings
    // forward instead of being re-reviewed.
    let reviewDiff = finalDiff;
    let carried: Finding[] = [];
    let reusedCount = 0;
    let reusedSummary: ReviewResult['summary'] | undefined;
    let reusedSummaryValid = false;
    if (config.reviews.incremental && !args.full) {
      const cached = await loadReviewCache(root);
      if (
        canReuseCache(cached, {
          model: resolved.model,
          profile,
          minConfidence,
          promptFingerprint,
        })
      ) {
        reusedSummary = cached.review.summary;
        // The cached summary describes the cached FILE SET; only replay it
        // when the current changeset covers exactly the same files.
        reusedSummaryValid = samePathSet(cached, finalDiff.files);
        const { fresh, unchanged } = partitionForIncremental(
          finalDiff.files,
          cached.context.diffHashes ?? {},
        );
        if (unchanged.length > 0) {
          carried = carriedFindings(
            cached,
            new Set(unchanged.map((f) => f.path)),
            minConfidence,
          );
          reusedCount = unchanged.length;
          reviewDiff = {
            ...finalDiff,
            files: fresh,
            totalAdditions: fresh.reduce((n, f) => n + f.additions, 0),
            totalDeletions: fresh.reduce((n, f) => n + f.deletions, 0),
          };
          log.dim(
            `incremental: ${unchanged.length} file(s) unchanged since the last review — reusing their findings (run with --full to re-review).`,
          );
        }
      }
    }

    // Everything unchanged AND the file set is identical: rebuild the result
    // from cache with zero API spend. (If the file set shrank, fall through —
    // the findings are still carried but the summary is regenerated.)
    if (
      reusedCount > 0 &&
      reviewDiff.files.length === 0 &&
      reusedSummaryValid
    ) {
      const findings = mergeFindings([], carried);
      const review: ReviewResult = {
        summary: reusedSummary ?? emptySummary(),
        findings,
        stats: {
          ...emptyStats(
            resolved.model,
            resolved.provider,
            resolved.subscription,
          ),
          // Same accounting as the engine: binary/hunk-less files are not
          // "reviewed".
          filesReviewed: finalDiff.files.filter(
            (f) => !f.binary && f.hunks.length > 0,
          ).length,
          filesSkipped: droppedByLimit + skippedByFilter,
          additions: finalDiff.totalAdditions,
          deletions: finalDiff.totalDeletions,
          findingsBySeverity: countBySeverity(findings),
        },
      };
      await saveReviewCache(root, finalDiff, review, {
        profile,
        minConfidence,
        promptFingerprint,
      }).catch(() => {});
      await recordUsage(root, review.stats).catch(() => {});
      if (format === 'agent') {
        const emitter = new AgentEmitter();
        emitter.reviewContext(finalDiff, root);
        for (const f of review.findings) {
          emitter.onReviewEvent({ type: 'finding', finding: f });
        }
        emitter.complete(review.stats);
      } else {
        emitOutput(format, review, finalDiff, undefined, {
          diagrams: config.output.markdownDiagrams,
          effort: config.reviews.estimateEffort,
          mergeConfidence: config.reviews.mergeConfidence,
          aiPrompts: config.reviews.promptForAiAgents,
        });
      }
      if (failOn) {
        const worst = review.findings.reduce(
          (max, f) => Math.max(max, SEVERITY_RANK[f.severity]),
          0,
        );
        if (worst >= SEVERITY_RANK[failOn]) process.exitCode = 2;
      }
      return;
    }

    // Budget guard (beyond-parity): abort before spending if the estimated API
    // cost would exceed the cap. Subscriptions are covered by the plan, so skip.
    if (budget > 0 && !resolved.subscription) {
      const chars = serializeDiffSet(reviewDiff, { maxChars: 5_000_000 }).text
        .length;
      // On incremental runs the summary pass still serializes the WHOLE
      // changeset (capped at the per-batch budget) — include it.
      const summaryChars =
        reusedCount > 0
          ? serializeDiffSet(finalDiff, { maxChars: 120_000 }).text.length
          : 0;
      // findings + summary passes both see the diff; add slack for prompts.
      const estInput = Math.ceil(((chars + summaryChars) / 4) * 1.2) + 1500;
      const estOutput = finalDiff.files.length * 350 + 800;
      const est = estimateCostUsd(
        resolved.model,
        { input: estInput, output: estOutput },
        { provider: resolved.provider },
      );
      if (est !== undefined && est > budget) {
        log.error(
          `Estimated cost ~$${est.toFixed(3)} exceeds --budget $${budget.toFixed(2)}. Use --light, narrow the diff, or raise the budget.`,
        );
        process.exitCode = 1;
        return;
      }
    }

    // Static-analysis grounding: run installed linters on changed lines and feed
    // their findings to the model to verify/dedupe/prioritize. Tools run against
    // the WORKING TREE, so changed-line filtering is only sound when the working
    // tree is what's under review — skip for commit/range/base-commit targets.
    const staticSafeTarget =
      target.kind === 'working' ||
      target.kind === 'staged' ||
      target.kind === 'all' ||
      target.kind === 'branch';
    const analysis = await runStaticAnalysis(reviewDiff, {
      repoRoot: root,
      toggles: config.reviews.tools,
      enabled: !args['no-static'] && staticSafeTarget,
      typeVerify: config.reviews.typeVerify,
    });
    if (analysis.ran.length > 0) {
      log.dim(`static analysis: ${analysis.ran.join(', ')}`);
    }

    const promptContext: PromptContext = {
      profile,
      minConfidence,
      customFocus,
      guidelines,
      pathInstructions,
      learnings,
      staticFindings: analysis.groundingText,
      fullFiles,
      history,
      language: config.language,
      toneInstructions: config.toneInstructions,
      sequenceDiagrams: config.reviews.sequenceDiagrams,
    };

    // Run the review.
    const agentEmitter = format === 'agent' ? new AgentEmitter() : undefined;
    if (agentEmitter) agentEmitter.reviewContext(finalDiff, root);

    // Agent mode: carried findings must reach the stream BEFORE the engine's
    // final "review_completed" status event (consumers may stop reading at
    // it). Count fresh finding events so carried ids continue the sequence —
    // mergeFindings assigns the same ids afterwards.
    let freshFindingEvents = 0;
    let carriedStreamed = false;
    const streamCarried = () => {
      if (!agentEmitter || carriedStreamed) return;
      carriedStreamed = true;
      carried.forEach((f, i) => {
        agentEmitter.onReviewEvent({
          type: 'finding',
          finding: { ...f, id: `ERG-${freshFindingEvents + i + 1}` },
        });
      });
    };

    const onEvent = (event: ReviewEvent) => {
      if (agentEmitter) {
        if (event.type === 'finding') freshFindingEvents += 1;
        if (event.type === 'status' && event.phase === 'completed') {
          streamCarried();
        }
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
        return;
      }
      // A failed findings batch means PARTIAL coverage — never let it pass
      // silently as a clean review.
      if (event.type === 'tool_skipped') {
        log.error(`review batch failed (results are partial): ${event.reason}`);
      }
    };

    let review: ReviewResult;
    try {
      review = await runReview({
        diff: reviewDiff,
        // Incremental runs review a subset; the summary must still describe
        // the whole changeset.
        summaryDiff: reusedCount > 0 ? finalDiff : undefined,
        resolved,
        promptContext,
        generateSummary: !args['no-summary'] && config.reviews.highLevelSummary,
        temperature: config.model.temperature,
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

    // Fold carried-forward findings back in and restore whole-changeset stats.
    if (reusedCount > 0) {
      // Safety net: if the engine never emitted a completed status (it always
      // should), make sure carried findings still reach the agent stream.
      streamCarried();
      review.findings = mergeFindings(review.findings, carried);
      review.stats.findingsBySeverity = countBySeverity(review.findings);
      review.stats.filesReviewed += reusedCount;
      review.stats.additions = finalDiff.totalAdditions;
      review.stats.deletions = finalDiff.totalDeletions;
    }

    // reviews.changed_files_summary / sequence_diagrams: honor the toggles in
    // the emitted result (the prompt already discourages generation, but the
    // model may still return the fields).
    if (!config.reviews.changedFilesSummary) {
      review.summary.fileSummaries = [];
    }
    if (!config.reviews.sequenceDiagrams) {
      review.summary.sequenceDiagram = undefined;
    }

    review.stats.filesSkipped += droppedByLimit;
    if (skippedByFilter > 0) {
      review.stats.filesSkipped += skippedByFilter;
    }
    if (review.stats.unreviewedFiles?.length) {
      log.error(
        `PARTIAL COVERAGE: ${review.stats.unreviewedFiles.length} file(s) were not reviewed (batch failures): ${review.stats.unreviewedFiles.join(', ')}. Re-run to retry them.`,
      );
    }

    // Persist for `ergo review findings` replay and `ergo fix`; log usage.
    await saveReviewCache(root, finalDiff, review, {
      profile,
      minConfidence,
      promptFingerprint,
    }).catch(() => {});
    await recordUsage(root, review.stats).catch(() => {});

    // Emit output.
    emitOutput(format, review, finalDiff, agentEmitter, {
      diagrams: config.output.markdownDiagrams,
      effort: config.reviews.estimateEffort,
      mergeConfidence: config.reviews.mergeConfidence,
      aiPrompts: config.reviews.promptForAiAgents,
    });

    // Exit code policy (failOn validated above).
    if (failOn) {
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
  opts: {
    diagrams?: boolean;
    effort?: boolean;
    mergeConfidence?: boolean;
    aiPrompts?: boolean;
  } = {},
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
      process.stdout.write(
        `${renderMarkdown(review, diff, {
          diagrams: opts.diagrams,
          effort: opts.effort,
          mergeConfidence: opts.mergeConfidence,
          aiPrompts: opts.aiPrompts,
        })}\n`,
      );
      break;
    case 'plain':
      process.stdout.write(
        `${renderTerminal(review, {
          plain: true,
          effort: opts.effort,
          mergeConfidence: opts.mergeConfidence,
        })}\n`,
      );
      break;
    default:
      process.stdout.write(
        `${renderTerminal(review, {
          effort: opts.effort,
          mergeConfidence: opts.mergeConfidence,
        })}\n`,
      );
  }
}

// CodeRabbit's pr_titles entries are regexes; fall back to a case-insensitive
// substring match when the pattern doesn't compile.
function matchesTitlePattern(subject: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(subject);
  } catch {
    return subject.toLowerCase().includes(pattern.toLowerCase());
  }
}

// Resolve a user-supplied format string (with aliases) to an OutputFormat.
// Returns null for an unrecognized value so the caller can report it — silently
// falling back to pretty would corrupt a piped `--format json` flow on a typo.
export function normalizeFormat(
  format: string | undefined,
): OutputFormat | null {
  if (!format) return 'pretty';
  const f = format.toLowerCase();
  if (f === 'ndjson') return 'agent';
  if (f === 'md') return 'markdown';
  if (OUTPUT_FORMATS.includes(f as OutputFormat)) return f as OutputFormat;
  return null;
}

// Report a fatal error. In `agent` mode, emit a structured NDJSON error event so
// the agent stream is never silently empty; otherwise log to stderr.
function handleFatal(
  err: unknown,
  format: OutputFormat,
  agentErrorType: 'auth' | 'connection' | 'review' | 'unknown' = 'unknown',
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (format === 'agent') {
    new AgentEmitter().error(agentErrorType, message, false);
  } else {
    log.error(message);
  }
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

function emptyStats(
  model: string,
  provider: string,
  subscriptionCovered: boolean,
) {
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
    subscriptionCovered,
    model,
    provider,
    durationMs: 0,
  };
}
