import { resolve as resolvePath } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defineCommand } from 'citty';
import { z } from 'zod';

import { runStaticAnalysis } from '@/analysis/runner';
import { getActiveCredential } from '@/auth/resolve';
import { makePathFilter } from '@/config/filters';
import { loadConfig } from '@/config/load';
import { collectDiff, type DiffSet, type ReviewTarget } from '@/git/diff';
import { isGitRepo, repoRoot } from '@/git/repo';
import { resolveClient } from '@/inference/resolve';
import {
  addLearning,
  listLearnings,
  loadLearningsForPrompt,
} from '@/memory/learnings';
import { recordUsage } from '@/memory/usage';
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
import { runReview } from '@/review/engine';
import {
  computePromptFingerprint,
  countBySeverity,
  mergeFindings,
  planIncremental,
} from '@/review/incremental';
import type { ReviewFinding, ReviewResult } from '@/review/schema';
import { VERSION } from '@/version';

function targetFrom(type?: string, base?: string): ReviewTarget {
  if (base) return { kind: 'branch', base };
  if (type === 'staged') return { kind: 'staged' };
  if (type === 'committed') return { kind: 'branch', base: 'auto' };
  return { kind: 'working' };
}

function emptyMcpSummary() {
  return {
    summary: 'No changes since the last review; findings reused from cache.',
    walkthrough: '',
    fileSummaries: [],
    effort: 1,
    mergeConfidence: 5,
    sequenceDiagram: undefined,
  };
}

function emptyMcpStats(
  resolved: ReturnType<typeof resolveClient>,
  diff: DiffSet,
  findings: ReviewFinding[],
) {
  return {
    filesReviewed: diff.files.filter((f) => !f.binary && f.hunks.length > 0)
      .length,
    filesSkipped: 0,
    additions: diff.totalAdditions,
    deletions: diff.totalDeletions,
    findingsBySeverity: countBySeverity(findings),
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    subscriptionCovered: resolved.subscription,
    model: resolved.model,
    provider: resolved.provider,
    durationMs: 0,
  };
}

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

async function resolveRoot(dir?: string): Promise<string | undefined> {
  const cwd = dir ? resolvePath(dir) : process.cwd();
  if (!(await isGitRepo(cwd))) return undefined;
  return repoRoot(cwd);
}

// For learnings tools: a provided-but-invalid dir is an error; an omitted dir
// falls back to cwd (learnings are keyed by path, not strictly a git repo).
async function resolveLearningsRoot(
  dir?: string,
): Promise<{ root?: string; error?: string }> {
  const cwd = dir ? resolvePath(dir) : process.cwd();
  if (await isGitRepo(cwd)) return { root: await repoRoot(cwd) };
  if (dir) return { error: `Not a git repository: ${dir}` };
  return { root: cwd };
}

// Build the MCP server with ergo's review tools. Exported for testing.
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'ergo', version: VERSION });

  server.registerTool(
    'ergo_review',
    {
      description:
        'Run an AI code review of local git changes and return structured findings (severity, category, confidence, suggested fix) plus a summary.',
      inputSchema: {
        dir: z.string().optional().describe('Repo path (default: cwd)'),
        type: z
          .enum(['all', 'committed', 'uncommitted', 'staged'])
          .optional()
          .describe('Review scope'),
        base: z.string().optional().describe('Base branch to diff against'),
        model: z.string().optional(),
      },
    },
    async ({ dir, type, base, model }) => {
      try {
        const root = await resolveRoot(dir);
        if (!root) return err('Not a git repository.');
        const { config } = await loadConfig(root);
        const credential = await getActiveCredential();
        const resolved = resolveClient({
          credential,
          modelOverride: model ?? config.model.default,
        });
        const diff = await collectDiff(targetFrom(type, base), { cwd: root });
        const pathFilter = makePathFilter(config.reviews.pathFilters);
        const files = diff.files.filter(
          (f) => !f.isGenerated && pathFilter(f.path),
        );
        if (files.length === 0) return ok({ findings: [], summary: null });
        const filtered: DiffSet = { ...diff, files };
        // Apply the same knowledge the CLI review applies: guidelines,
        // stored learnings, path instructions, and custom agents.
        const [guidelines, learnings] = await Promise.all([
          gatherGuidelines(root, config),
          config.knowledgeBase.optOut
            ? Promise.resolve(undefined)
            : loadLearningsForPrompt(root, config.knowledgeBase.learningsScope),
        ]);
        const pathInstructions = gatherPathInstructions(filtered, config);
        const customAgents = gatherCustomAgents(filtered, config);
        // targetFrom only produces working/staged/branch targets — all
        // working-tree-safe for full-file context.
        const fullFiles = config.reviews.wholeRepoContext
          ? await gatherFullFileContext(root, files)
          : undefined;
        const history = config.reviews.historyContext
          ? await gatherHistoryContext(root, files)
          : undefined;
        const promptFingerprint = computePromptFingerprint({
          guidelines,
          learnings,
          pathInstructions,
          customAgents,
          customFocus: customAgents,
          toneInstructions: config.toneInstructions,
          language: config.language,
          reasoningEffort: config.model.reasoningEffort,
          wholeRepoContext: Boolean(fullFiles),
          history,
        });

        // Incremental reuse — same semantics as the CLI: unchanged files
        // (identical rendered diff + prompt context) carry findings forward.
        const plan = config.reviews.incremental
          ? planIncremental(await loadReviewCache(root), files, {
              model: resolved.model,
              profile: config.reviews.profile,
              minConfidence: config.reviews.minConfidence,
              promptFingerprint,
            })
          : {
              freshFiles: files,
              carried: [],
              reusedCount: 0,
              summaryReusable: false,
              summary: undefined,
            };
        const reviewDiff: DiffSet = { ...filtered, files: plan.freshFiles };

        let review: ReviewResult;
        if (plan.freshFiles.length === 0 && plan.summaryReusable) {
          // Everything unchanged: zero-spend replay.
          const findings = mergeFindings([], plan.carried);
          review = {
            summary: plan.summary ?? emptyMcpSummary(),
            findings,
            stats: emptyMcpStats(resolved, filtered, findings),
          };
        } else {
          // Static-analysis grounding on the fresh subset (targetFrom only
          // produces working/staged/branch targets — all working-tree-safe).
          const analysis = await runStaticAnalysis(reviewDiff, {
            repoRoot: root,
            toggles: config.reviews.tools,
            typeVerify: config.reviews.typeVerify,
          });
          review = await runReview({
            diff: reviewDiff,
            summaryDiff: plan.reusedCount > 0 ? filtered : undefined,
            resolved,
            promptContext: {
              profile: config.reviews.profile,
              minConfidence: config.reviews.minConfidence,
              customFocus: customAgents,
              guidelines,
              pathInstructions,
              learnings,
              staticFindings: analysis.groundingText,
              fullFiles,
              history,
              language: config.language,
              toneInstructions: config.toneInstructions,
              sequenceDiagrams: config.reviews.sequenceDiagrams,
            },
            temperature: config.model.temperature,
            reasoningEffort: config.model.reasoningEffort,
          });
          if (plan.reusedCount > 0) {
            review.findings = mergeFindings(review.findings, plan.carried);
            review.stats.findingsBySeverity = countBySeverity(review.findings);
            review.stats.filesReviewed += plan.reusedCount;
            review.stats.additions = filtered.totalAdditions;
            review.stats.deletions = filtered.totalDeletions;
          }
        }

        // Persist so ergo_findings / `ergo fix` see this review, and count it
        // in `ergo stats` — same behavior as the CLI path.
        await saveReviewCache(root, filtered, review, {
          profile: config.reviews.profile,
          minConfidence: config.reviews.minConfidence,
          promptFingerprint,
        }).catch(() => {});
        await recordUsage(root, review.stats).catch(() => {});
        return ok({
          summary: review.summary,
          findings: review.findings,
          stats: review.stats,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'ergo_findings',
    {
      description:
        'Return the most recent cached review for a repo (no re-run).',
      inputSchema: { dir: z.string().optional() },
    },
    async ({ dir }) => {
      try {
        const root = await resolveRoot(dir);
        if (!root) return err('Not a git repository.');
        const cached = await loadReviewCache(root);
        if (!cached) return err('No cached review. Run ergo_review first.');
        return ok({
          savedAt: cached.savedAt,
          context: diffSetFromCache(cached).files.map((f) => f.path),
          findings: cached.review.findings,
          summary: cached.review.summary,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'ergo_list_learnings',
    {
      description:
        'List ergo review learnings (durable preferences) for a repo.',
      inputSchema: {
        dir: z.string().optional(),
        scope: z.enum(['local', 'global', 'auto']).optional(),
      },
    },
    async ({ dir, scope }) => {
      try {
        const { root, error } = await resolveLearningsRoot(dir);
        if (error || !root) return err(error ?? 'Could not resolve directory.');
        return ok(await listLearnings(root, scope ?? 'auto'));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'ergo_add_learning',
    {
      description:
        'Record a durable review preference ergo should apply later.',
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(2000)
          .describe('The learning/preference to remember'),
        dir: z.string().optional(),
        global: z.boolean().optional(),
      },
    },
    async ({ text, dir, global }) => {
      try {
        const { root, error } = await resolveLearningsRoot(dir);
        if (error || !root) return err(error ?? 'Could not resolve directory.');
        const learning = await addLearning(root, text, {
          scope: global ? 'global' : 'local',
        });
        return ok(learning);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}

export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'Run ergo as an MCP server (stdio) exposing review tools',
  },
  async run() {
    const server = buildMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Keep the process alive; the transport handles stdin/stdout.
    await new Promise<void>(() => {});
  },
});
