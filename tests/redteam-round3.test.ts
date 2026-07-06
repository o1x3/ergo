import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCredentialFromEnv } from '@/auth/storage';
import { loadConfig, parseConfigString } from '@/config/load';
import { collectDiff, parseUnifiedDiff } from '@/git/diff';
import { fetchCodexWithRetry } from '@/inference/codex-client';
import type {
  CompletionRequest,
  CompletionResult,
  ModelClient,
} from '@/inference/types';
import { gatherCustomAgents } from '@/review/context';
import { runReview } from '@/review/engine';
import { exec } from '@/util/exec';

// ---------------------------------------------------------------------------
// Round-3 red-team regression tests.
// ---------------------------------------------------------------------------

async function initRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ergo-rt3-'));
  const g = (args: string[]) =>
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
  await g(['init', '-q']);
  return root;
}

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

describe('non-ASCII filenames survive diff collection (core.quotePath)', () => {
  test('modified file with accented name keeps its real path', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'café.ts'), 'const a = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'café.ts'), 'const a = 2;\n');

    const diff = await collectDiff({ kind: 'working' }, { cwd: root });
    expect(diff.files.length).toBe(1);
    expect(diff.files[0]!.path).toBe('café.ts');
    expect(diff.files[0]!.additions).toBe(1);
  });

  test('untracked file with non-ASCII name is included with its real path', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'base.ts'), 'export {};\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'naïve.ts'), 'const x = 1;\n');

    const diff = await collectDiff({ kind: 'working' }, { cwd: root });
    const paths = diff.files.map((f) => f.path);
    expect(paths).toContain('naïve.ts');
  });
});

describe('exec: missing binary', () => {
  test('returns exit 127 instead of throwing', async () => {
    const out = await exec(['ergo-definitely-not-a-real-binary-xyz']);
    expect(out.exitCode).toBe(127);
    expect(out.stderr).toContain('failed to run');
  });
});

describe('fetchCodexWithRetry: transient network errors', () => {
  const okResponse = () => new Response('ok', { status: 200 });
  const noSleep = async () => {};

  test('retries a thrown network error and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return okResponse();
    }) as unknown as typeof fetch;
    const res = await fetchCodexWithRetry(
      fetchImpl,
      'https://x',
      {},
      { sleep: noSleep, random: () => 0 },
    );
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test('propagates an AbortError immediately without retrying', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new DOMException('Aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(
      fetchCodexWithRetry(fetchImpl, 'https://x', {}, { sleep: noSleep }),
    ).rejects.toThrow('Aborted');
    expect(calls).toBe(1);
  });

  test('throws the last network error after exhausting attempts', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      fetchCodexWithRetry(
        fetchImpl,
        'https://x',
        {},
        { sleep: noSleep, random: () => 0, retry: { maxAttempts: 3 } },
      ),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });
});

describe('loadConfig: malformed YAML is an error, not a silent skip', () => {
  async function isolatedEnv(): Promise<{
    env: NodeJS.ProcessEnv;
    root: string;
  }> {
    const root = mkdtempSync(join(tmpdir(), 'ergo-cfg-'));
    const xdg = mkdtempSync(join(tmpdir(), 'ergo-xdg-'));
    // Plant an empty global config so the loader never falls through to the
    // real user's ~/.config/ergo/config.yaml.
    await mkdir(join(xdg, 'ergo'), { recursive: true });
    await writeFile(join(xdg, 'ergo', 'config.yaml'), '{}\n');
    return {
      env: { XDG_CONFIG_HOME: xdg, ERGO_HOME: join(xdg, 'home') },
      root,
    };
  }

  test('reports invalid YAML in errors', async () => {
    const { env, root } = await isolatedEnv();
    await writeFile(join(root, '.ergo.yaml'), 'reviews: [unclosed\n');
    const { errors } = await loadConfig(root, env);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('invalid YAML');
  });

  test('valid YAML still loads cleanly', async () => {
    const { env, root } = await isolatedEnv();
    await writeFile(join(root, '.ergo.yaml'), 'reviews:\n  profile: chill\n');
    const { errors, sources } = await loadConfig(root, env);
    expect(errors.length).toBe(0);
    expect(sources.some((s) => s.endsWith('.ergo.yaml'))).toBe(true);
  });
});

describe('resolveCredentialFromEnv: ERGO_PROVIDER validation', () => {
  test('throws on an unknown provider instead of misrouting the key', () => {
    expect(() =>
      resolveCredentialFromEnv({
        ERGO_API_KEY: 'sk-test',
        ERGO_PROVIDER: 'opnai',
      } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown ERGO_PROVIDER 'opnai'/);
  });

  test('accepts a valid provider', () => {
    const cred = resolveCredentialFromEnv({
      ERGO_API_KEY: 'sk-test',
      ERGO_PROVIDER: 'anthropic',
    } as NodeJS.ProcessEnv);
    expect(cred?.provider).toBe('anthropic');
  });

  test('ignores ERGO_PROVIDER when no ERGO_API_KEY is set', () => {
    const cred = resolveCredentialFromEnv({
      ERGO_PROVIDER: 'garbage',
    } as NodeJS.ProcessEnv);
    expect(cred).toBeUndefined();
  });
});

describe('custom agents: file_paths and exclude are honored', () => {
  const diffFor = (paths: string[]) => ({
    files: paths.map((p) => ({
      path: p,
      status: 'modified' as const,
      binary: false,
      hunks: [],
      additions: 1,
      deletions: 0,
      language: 'typescript',
    })),
    target: { kind: 'working' as const },
    totalAdditions: paths.length,
    totalDeletions: 0,
  });

  test('file_paths acts as include', () => {
    const { config } = parseConfigString(
      [
        'reviews:',
        '  custom_agents:',
        '    - name: sql-check',
        '      instructions: "no raw sql"',
        '      file_paths: ["src/db/**"]',
      ].join('\n'),
    );
    expect(config).toBeDefined();
    const hit = gatherCustomAgents(diffFor(['src/db/q.ts']), config!);
    expect(hit).toContain('sql-check');
    const miss = gatherCustomAgents(diffFor(['docs/readme.md']), config!);
    expect(miss).toBeUndefined();
  });

  test('exclude removes otherwise-matching files', () => {
    const { config } = parseConfigString(
      [
        'reviews:',
        '  custom_agents:',
        '    - name: ts-rules',
        '      instructions: "strict ts"',
        '      include: ["**/*.ts"]',
        '      exclude: ["**/*.test.ts"]',
      ].join('\n'),
    );
    expect(config).toBeDefined();
    // Only an excluded file changed → the agent must not fire.
    const excluded = gatherCustomAgents(diffFor(['src/a.test.ts']), config!);
    expect(excluded).toBeUndefined();
    // A non-excluded match → fires.
    const included = gatherCustomAgents(
      diffFor(['src/a.test.ts', 'src/a.ts']),
      config!,
    );
    expect(included).toContain('ts-rules');
  });
});

describe('engine: config temperature override reaches the model', () => {
  const SAMPLE = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

  test('temperature option overrides both passes', async () => {
    const temps: Array<number | undefined> = [];
    const client: ModelClient = {
      provider: 'openai',
      async complete(req: CompletionRequest): Promise<CompletionResult> {
        temps.push(req.temperature);
        const props = (req.jsonSchema?.properties ?? {}) as Record<
          string,
          unknown
        >;
        const text =
          'findings' in props
            ? JSON.stringify({ findings: [] })
            : JSON.stringify({
                summary: 's',
                walkthrough: '',
                fileSummaries: [],
                effort: 1,
                mergeConfidence: 5,
              });
        return { text, finishReason: 'stop', usage: { input: 1, output: 1 } };
      },
    };
    const files = parseUnifiedDiff(SAMPLE);
    await runReview({
      diff: {
        files,
        target: { kind: 'working' },
        totalAdditions: 1,
        totalDeletions: 1,
      },
      resolved: {
        client,
        model: 'test-model',
        provider: 'openai',
        subscription: false,
      },
      promptContext: { profile: 'chill', minConfidence: 0.6 },
      temperature: 0.7,
    });
    expect(temps.length).toBe(2);
    for (const t of temps) expect(t).toBe(0.7);
  });
});

describe('review CLI: validation and max_changed_lines (e2e)', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');

  async function repoWithBigChange(): Promise<string> {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(
      join(root, '.ergo.yaml'),
      'reviews:\n  ignore:\n    max_changed_lines: 1\n',
    );
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\nconst b = 3;\n');
    return root;
  }

  function cliEnv(): Record<string, string> {
    const xdg = mkdtempSync(join(tmpdir(), 'ergo-xdg-'));
    return {
      ERGO_API_KEY: 'sk-test',
      ERGO_HOME: mkdtempSync(join(tmpdir(), 'ergo-home-')),
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
  }

  test('--fail-on typo exits 1 before spending anything', async () => {
    const root = await repoWithBigChange();
    const out = await exec(
      ['bun', CLI, 'review', '--fail-on', 'bogus', '--dir', root],
      { env: cliEnv() },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Invalid --fail-on 'bogus'");
  });

  test('max_changed_lines skips the review but still emits valid JSON; --fail-on is case-insensitive', async () => {
    const root = await repoWithBigChange();
    const out = await exec(
      [
        'bun',
        CLI,
        'review',
        '--fail-on',
        'CRITICAL',
        '--format',
        'json',
        '--dir',
        root,
      ],
      { env: cliEnv() },
    );
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(out.stdout) as { findings: unknown[] };
    expect(doc.findings).toEqual([]);
  });

  test('max_changed_lines skip is announced in human output', async () => {
    const root = await repoWithBigChange();
    const out = await exec(['bun', CLI, 'review', '--dir', root], {
      env: cliEnv(),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('max_changed_lines');
  });
});

describe('static-analysis tool arg modernization', () => {
  test('gitleaks primary args use the v8.19+ dir command', async () => {
    const { getToolByName } = await import('@/analysis/tools');
    const gitleaks = getToolByName('gitleaks')!;
    const args = gitleaks.buildArgs([], { repoRoot: '/repo' })!;
    expect(args[0]).toBe('dir');
    const alt = gitleaks.altArgs!([], { repoRoot: '/repo' })!;
    expect(alt).toContain('--no-git');
  });

  test('golangci-lint primary args use v2 output flags with v1 fallback', async () => {
    const { getToolByName } = await import('@/analysis/tools');
    const lint = getToolByName('golangci-lint')!;
    const args = lint.buildArgs([], { repoRoot: '/repo' })!;
    expect(args).toContain('--output.json.path');
    const alt = lint.altArgs!([], { repoRoot: '/repo' })!;
    expect(alt).toContain('--out-format');
  });
});
