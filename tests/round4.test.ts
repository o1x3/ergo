import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfigString } from '@/config/load';
import { collectDiff, parseUnifiedDiff } from '@/git/diff';
import { extractJson } from '@/inference/structured';
import { humanCount } from '@/output/format';
import { type CachedReview, computeDiffHashes } from '@/review/cache';
import { gatherGuidelines } from '@/review/context';
import {
  canReuseCache,
  carriedFindings,
  computePromptFingerprint,
  countBySeverity,
  mergeFindings,
  partitionForIncremental,
  planIncremental,
  samePathSet,
} from '@/review/incremental';
import type { Finding, ReviewFinding } from '@/review/schema';
import { mapLimit } from '@/util/concurrency';
import { exec } from '@/util/exec';

// ---------------------------------------------------------------------------
// Round-4: incremental reviews, policy skips, context patterns, micro-fixes.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');

// Local mock API: every request 401s instantly (non-retryable), so a CLI run
// that attempts a model call fails fast without ever touching the network.
const mockApi = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      JSON.stringify({
        error: {
          message: 'unauthorized (test)',
          type: 'invalid_request_error',
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
});
afterAll(() => {
  mockApi.stop(true);
});

// The fingerprint an out-of-the-box run computes (no guidelines, learnings,
// path instructions, custom agents, focus, or tone; default language/effort).
const DEFAULT_FINGERPRINT = computePromptFingerprint({
  pathInstructions: undefined,
  customAgents: undefined,
  language: 'en-US',
});

function gitIn(root: string) {
  return (args: string[]) =>
    exec(
      [
        'git',
        '-c',
        'user.email=test@test',
        '-c',
        'user.name=test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, env: { GIT_CONFIG_GLOBAL: '/dev/null' } },
    );
}

async function initRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ergo-rt4-'));
  await gitIn(root)(['init', '-q']);
  return root;
}

// Canonical repo root as git reports it (macOS /var → /private/var).
async function canonicalRoot(root: string): Promise<string> {
  const { stdout } = await exec(['git', 'rev-parse', '--show-toplevel'], {
    cwd: root,
  });
  return stdout.trim();
}

function cliEnv(): Record<string, string> {
  return {
    ERGO_API_KEY: 'sk-test',
    // exec() merges over process.env, so ambient keys must be OVERRIDDEN
    // (empty string = unset for resolveCredentialFromEnv), not deleted.
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ERGO_PROVIDER: '',
    // Point any API call at the instant-401 mock: fails fast, never touches
    // the real network.
    ERGO_BASE_URL: `http://127.0.0.1:${mockApi.port}/v1`,
    ERGO_HOME: mkdtempSync(join(tmpdir(), 'ergo-home-')),
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'ergo-xdg-')),
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

function mkFinding(over: Partial<Finding> & { file: string }): Finding {
  return {
    startLine: 1,
    endLine: 1,
    severity: 'minor',
    category: 'correctness',
    title: 't',
    description: 'd',
    rationale: 'r',
    confidence: 0.9,
    codegenInstructions: 'c',
    ...over,
  };
}

function mkCache(over: {
  diffHashes?: Record<string, string>;
  profile?: 'chill' | 'assertive';
  minConfidence?: number;
  model?: string;
  findings?: ReviewFinding[];
  promptFingerprint?: string;
  files?: Array<{ path: string }>;
}): CachedReview {
  return {
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/r',
    context: {
      target: 'working',
      files: (over.files ?? [{ path: 'a.ts' }]).map((f) => ({
        path: f.path,
        status: 'modified',
        additions: 1,
        deletions: 0,
        language: 'typescript',
      })),
      fileHashes: {},
      diffHashes: over.diffHashes ?? { 'a.ts': 'h' },
      profile: over.profile ?? 'chill',
      minConfidence: over.minConfidence ?? 0.6,
      promptFingerprint: over.promptFingerprint ?? DEFAULT_FINGERPRINT,
    },
    review: {
      summary: {
        summary: 's',
        walkthrough: '',
        fileSummaries: [],
        effort: 1,
        mergeConfidence: 5,
        sequenceDiagram: undefined,
      },
      findings: over.findings ?? [],
      stats: {
        filesReviewed: 1,
        filesSkipped: 0,
        additions: 1,
        deletions: 0,
        findingsBySeverity: {
          critical: 0,
          major: 0,
          minor: 0,
          suggestion: 0,
          info: 0,
        },
        tokensInput: 10,
        tokensOutput: 10,
        costUsd: 0,
        subscriptionCovered: false,
        model: over.model ?? 'gpt-5.4',
        provider: 'openai',
        durationMs: 1,
      },
    },
  };
}

describe('incremental: canReuseCache guards', () => {
  const ctx = {
    model: 'gpt-5.4',
    profile: 'chill' as const,
    minConfidence: 0.6,
    promptFingerprint: DEFAULT_FINGERPRINT,
  };

  test('accepts a compatible cache', () => {
    expect(canReuseCache(mkCache({}), ctx)).toBe(true);
  });
  test('rejects missing cache or diff hashes', () => {
    expect(canReuseCache(undefined, ctx)).toBe(false);
    expect(canReuseCache(mkCache({ diffHashes: {} }), ctx)).toBe(false);
  });
  test('rejects profile and model mismatches', () => {
    expect(canReuseCache(mkCache({ profile: 'assertive' }), ctx)).toBe(false);
    expect(canReuseCache(mkCache({ model: 'gpt-5.5' }), ctx)).toBe(false);
  });
  test('rejects a different prompt fingerprint (guidelines/focus/effort changed)', () => {
    expect(canReuseCache(mkCache({ promptFingerprint: 'other' }), ctx)).toBe(
      false,
    );
    // And the fingerprint itself must move when any prompt input moves.
    expect(
      computePromptFingerprint({
        pathInstructions: undefined,
        customAgents: undefined,
        language: 'en-US',
        customFocus: 'check SQL injection',
      }),
    ).not.toBe(DEFAULT_FINGERPRINT);
    expect(
      computePromptFingerprint({
        pathInstructions: undefined,
        customAgents: undefined,
        language: 'en-US',
        reasoningEffort: 'high',
      }),
    ).not.toBe(DEFAULT_FINGERPRINT);
  });
  test('samePathSet compares the cached file set to the current one', () => {
    const cache = mkCache({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    const files = parseUnifiedDiff(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n',
    );
    expect(samePathSet(cache, files)).toBe(false);
    expect(samePathSet(mkCache({ files: [{ path: 'a.ts' }] }), files)).toBe(
      true,
    );
  });
  test('rejects a cache produced under a STRICTER confidence filter', () => {
    // Cached run dropped findings below 0.8; a 0.6 run needs those back.
    expect(canReuseCache(mkCache({ minConfidence: 0.8 }), ctx)).toBe(false);
    // Cached run was MORE permissive — fine, carried set gets re-filtered.
    expect(canReuseCache(mkCache({ minConfidence: 0.5 }), ctx)).toBe(true);
  });
});

describe('incremental: partition and merge', () => {
  const DIFF_A = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;
  const DIFF_A2 = DIFF_A.replace('a = 2', 'a = 3');

  test('identical rendered diff is unchanged; different is fresh', () => {
    const files = parseUnifiedDiff(DIFF_A);
    const cachedHashes = computeDiffHashes(files);
    const same = partitionForIncremental(files, cachedHashes);
    expect(same.unchanged.map((f) => f.path)).toEqual(['a.ts']);
    expect(same.fresh).toEqual([]);

    const editedFiles = parseUnifiedDiff(DIFF_A2);
    const edited = partitionForIncremental(editedFiles, cachedHashes);
    expect(edited.fresh.map((f) => f.path)).toEqual(['a.ts']);
    expect(edited.unchanged).toEqual([]);
  });

  test('carriedFindings filters by path and confidence, strips ids', () => {
    const cache = mkCache({
      findings: [
        { ...mkFinding({ file: 'a.ts', confidence: 0.9 }), id: 'ERG-1' },
        { ...mkFinding({ file: 'a.ts', confidence: 0.61 }), id: 'ERG-2' },
        { ...mkFinding({ file: 'b.ts', confidence: 0.9 }), id: 'ERG-3' },
      ],
    });
    const out = carriedFindings(cache, new Set(['a.ts']), 0.7);
    expect(out.length).toBe(1);
    expect(out[0]).not.toHaveProperty('id');
    expect(out[0]?.file).toBe('a.ts');
  });

  test('mergeFindings keeps fresh ids and continues numbering for carried', () => {
    const fresh: ReviewFinding[] = [
      { ...mkFinding({ file: 'f.ts', severity: 'minor' }), id: 'ERG-1' },
    ];
    const carried: Finding[] = [
      mkFinding({ file: 'c.ts', severity: 'critical' }),
    ];
    const merged = mergeFindings(fresh, carried);
    // Sorted by severity: the carried critical leads, but ids are stable.
    expect(merged[0]?.file).toBe('c.ts');
    expect(merged[0]?.id).toBe('ERG-2');
    expect(merged[1]?.id).toBe('ERG-1');
    const counts = countBySeverity(merged);
    expect(counts.critical).toBe(1);
    expect(counts.minor).toBe(1);
  });
});

describe('incremental: all-unchanged fast path (e2e, zero API calls)', () => {
  test('review replays carried findings without a network credential path', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');

    const canon = await canonicalRoot(root);
    const diff = await collectDiff({ kind: 'working' }, { cwd: canon });
    const cache = mkCache({
      diffHashes: computeDiffHashes(diff.files),
      findings: [
        {
          ...mkFinding({ file: 'a.ts', severity: 'major', confidence: 0.9 }),
          id: 'ERG-1',
        },
      ],
    });

    const env = cliEnv();
    const key = createHash('sha256').update(canon).digest('hex').slice(0, 16);
    await mkdir(join(env.ERGO_HOME as string, 'reviews'), { recursive: true });
    await writeFile(
      join(env.ERGO_HOME as string, 'reviews', `${key}.json`),
      JSON.stringify(cache),
    );

    const out = await exec(
      ['bun', CLI, 'review', '--format', 'json', '--dir', root],
      { env },
    );
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(out.stdout) as {
      findings: Array<{ id: string; file: string; severity: string }>;
      stats: { tokensInput: number; filesReviewed: number };
    };
    expect(doc.findings.length).toBe(1);
    expect(doc.findings[0]?.file).toBe('a.ts');
    expect(doc.stats.tokensInput).toBe(0);
    expect(doc.stats.filesReviewed).toBe(1);
  });

  test('--fail-on works against carried findings; --full bypasses reuse', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');

    const canon = await canonicalRoot(root);
    const diff = await collectDiff({ kind: 'working' }, { cwd: canon });
    const cache = mkCache({
      diffHashes: computeDiffHashes(diff.files),
      findings: [
        {
          ...mkFinding({ file: 'a.ts', severity: 'critical', confidence: 0.9 }),
          id: 'ERG-1',
        },
      ],
    });

    const env = cliEnv();
    const key = createHash('sha256').update(canon).digest('hex').slice(0, 16);
    await mkdir(join(env.ERGO_HOME as string, 'reviews'), { recursive: true });
    await writeFile(
      join(env.ERGO_HOME as string, 'reviews', `${key}.json`),
      JSON.stringify(cache),
    );

    // Carried critical finding must trip the CI gate (exit 2).
    const gated = await exec(
      [
        'bun',
        CLI,
        'review',
        '--fail-on',
        'critical',
        '--format',
        'json',
        '--dir',
        root,
      ],
      { env },
    );
    expect(gated.exitCode).toBe(2);

    // --full skips reuse → attempts a real review → fails on the fake key
    // (proves the reuse path was bypassed).
    const full = await exec(
      ['bun', CLI, 'review', '--full', '--format', 'json', '--dir', root],
      { env },
    );
    expect(full.exitCode).toBe(1);
  });
});

describe('incremental: partial partition (e2e)', () => {
  test('changing one of two files re-reviews only the changed file', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(join(root, 'b.ts'), 'const b = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');
    await writeFile(join(root, 'b.ts'), 'const b = 2;\n');

    const canon = await canonicalRoot(root);
    const diff = await collectDiff({ kind: 'working' }, { cwd: canon });
    const cache = mkCache({
      diffHashes: computeDiffHashes(diff.files),
      files: [{ path: 'a.ts' }, { path: 'b.ts' }],
      findings: [
        {
          ...mkFinding({ file: 'a.ts', severity: 'major', confidence: 0.9 }),
          id: 'ERG-1',
        },
      ],
    });

    const env = cliEnv();
    const key = createHash('sha256').update(canon).digest('hex').slice(0, 16);
    await mkdir(join(env.ERGO_HOME as string, 'reviews'), { recursive: true });
    await writeFile(
      join(env.ERGO_HOME as string, 'reviews', `${key}.json`),
      JSON.stringify(cache),
    );

    // Change b.ts AFTER computing the cache hashes: a.ts stays unchanged
    // (carried), b.ts needs a fresh model pass — which fails instantly on the
    // closed local port, proving the partition sent ONLY b.ts to the model.
    await writeFile(join(root, 'b.ts'), 'const b = 3;\n');
    const out = await exec(['bun', CLI, 'review', '--dir', root], { env });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('incremental: 1 file(s) unchanged');
    expect(out.stderr).toContain('review batch(es) failed');
  });
});

describe('policy skips (e2e)', () => {
  test('reviews.enabled: false skips without needing a credential', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(join(root, '.ergo.yaml'), 'reviews:\n  enabled: false\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');

    const env = cliEnv();
    env.ERGO_API_KEY = ''; // no credential — the skip must come first
    const pretty = await exec(['bun', CLI, 'review', '--dir', root], { env });
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toContain('reviews.enabled');

    const json = await exec(
      ['bun', CLI, 'review', '--format', 'json', '--dir', root],
      { env },
    );
    expect(json.exitCode).toBe(0);
    const doc = JSON.parse(json.stdout) as { findings: unknown[] };
    expect(doc.findings).toEqual([]);
  });

  test('ignore.head_branches skips matching branches', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(
      join(root, '.ergo.yaml'),
      'reviews:\n  ignore:\n    head_branches: ["wip/**"]\n',
    );
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await g(['checkout', '-q', '-b', 'wip/scratch']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');

    const env = cliEnv();
    env.ERGO_API_KEY = '';
    const out = await exec(['bun', CLI, 'review', '--dir', root], { env });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('head_branches');
  });
});

describe('guidelines: knowledge_base patterns are honored', () => {
  test('default patterns pick up tracked context files (incl. globs)', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'AGENTS.md'), 'agents rules\n');
    await mkdir(join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(join(root, '.cursor', 'rules', 'r1.md'), 'cursor rule\n');
    await g(['add', '-f', '.']);
    await g(['commit', '-q', '-m', 'init']);

    const { config } = parseConfigString('');
    const out = await gatherGuidelines(await canonicalRoot(root), config!);
    expect(out).toContain('agents rules');
    expect(out).toContain('cursor rule');
  });

  test('disabling both knowledge_base groups yields no guidelines', async () => {
    const root = await initRepo();
    await writeFile(join(root, 'AGENTS.md'), 'agents rules\n');
    const { config } = parseConfigString(
      [
        'knowledge_base:',
        '  context_files: { enabled: false }',
        '  code_guidelines: { enabled: false }',
      ].join('\n'),
    );
    const out = await gatherGuidelines(root, config!);
    expect(out).toBeUndefined();
  });
});

describe('micro-fixes', () => {
  test('extractJson skips bracketed prose before the real JSON', () => {
    expect(extractJson('[Note]: see below {"a": 1} trailing')).toBe('{"a": 1}');
  });
  test('extractJson still returns first balanced slice when nothing parses', () => {
    expect(extractJson('{oops: nope}')).toBe('{oops: nope}');
  });
  test('humanCount drops trailing zeros at higher precision', () => {
    expect(humanCount(1500, 2)).toBe('1.5K');
    expect(humanCount(1000, 2)).toBe('1K');
    expect(humanCount(999)).toBe('999');
    expect(humanCount(1234567)).toBe('1.2M');
  });
  test('mapLimit preserves order AND respects the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapLimit([3, 1, 2, 4, 1], 2, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, n * 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20, 40, 10]);
    expect(maxInFlight).toBe(2);
  });
});

describe('static-analysis scheduling guards', () => {
  test('whole-repo scanners stay marked serial', async () => {
    const { getToolByName } = await import('@/analysis/tools');
    for (const name of ['gitleaks', 'golangci-lint', 'clippy']) {
      expect(getToolByName(name)?.serial).toBe(true);
    }
    // Per-file linters must NOT be serialized.
    for (const name of ['eslint', 'ruff', 'shellcheck']) {
      expect(getToolByName(name)?.serial).toBeUndefined();
    }
  });
});

describe('guidelines: untracked context files are included', () => {
  test('a fresh (uncommitted) .cursor/rules dir feeds guidelines', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'base.ts'), 'export {};\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    // Untracked context files — must still be picked up by glob patterns.
    await mkdir(join(root, '.cursor', 'rules'), { recursive: true });
    await writeFile(join(root, '.cursor', 'rules', 'wip.md'), 'wip rule\n');

    const { config } = parseConfigString('');
    const out = await gatherGuidelines(await canonicalRoot(root), config!);
    expect(out).toContain('wip rule');
  });
});

describe('incremental: planIncremental (shared by CLI + MCP)', () => {
  const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;
  const ctx = {
    model: 'gpt-5.4',
    profile: 'chill' as const,
    minConfidence: 0.6,
    promptFingerprint: DEFAULT_FINGERPRINT,
  };

  test('incompatible cache yields a full-review plan', () => {
    const files = parseUnifiedDiff(DIFF);
    const plan = planIncremental(undefined, files, ctx);
    expect(plan.reusedCount).toBe(0);
    expect(plan.freshFiles).toEqual(files);
    expect(plan.summaryReusable).toBe(false);
  });

  test('matching cache carries findings and marks summary reusable', () => {
    const files = parseUnifiedDiff(DIFF);
    const cache = mkCache({
      diffHashes: computeDiffHashes(files),
      findings: [
        { ...mkFinding({ file: 'a.ts', confidence: 0.9 }), id: 'ERG-1' },
      ],
    });
    const plan = planIncremental(cache, files, ctx);
    expect(plan.reusedCount).toBe(1);
    expect(plan.freshFiles).toEqual([]);
    expect(plan.carried.length).toBe(1);
    expect(plan.summaryReusable).toBe(true);
    expect(plan.summary?.summary).toBe('s');
  });

  test('shrunken file set carries findings but not the summary', () => {
    const files = parseUnifiedDiff(DIFF);
    const cache = mkCache({
      diffHashes: { ...computeDiffHashes(files), 'b.ts': 'gone' },
      files: [{ path: 'a.ts' }, { path: 'b.ts' }],
      findings: [
        { ...mkFinding({ file: 'a.ts', confidence: 0.9 }), id: 'ERG-1' },
      ],
    });
    const plan = planIncremental(cache, files, ctx);
    expect(plan.reusedCount).toBe(1);
    expect(plan.summaryReusable).toBe(false);
  });
});
