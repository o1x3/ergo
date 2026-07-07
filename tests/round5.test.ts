import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSemver } from '@/cli/commands/update';
import { loadConfig, parseConfigString } from '@/config/load';
import { collectDiff } from '@/git/diff';
import { commitMeta } from '@/git/repo';
import { renderMarkdown } from '@/output/markdown';
import { stripAnsi } from '@/output/style';
import { renderTerminal } from '@/output/terminal';
import { gatherFullFileContext, gatherHistoryContext } from '@/review/context';
import type { ReviewResult } from '@/review/schema';
import { exec } from '@/util/exec';

// ---------------------------------------------------------------------------
// Round-5: previously-deferred config semantics.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');

function gitIn(root: string) {
  return (args: string[]) =>
    exec(
      [
        'git',
        '-c',
        'user.email=test@test',
        '-c',
        'user.name=Test Author',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, env: { GIT_CONFIG_GLOBAL: '/dev/null' } },
    );
}

async function initRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ergo-rt5-'));
  await gitIn(root)(['init', '-q', '-b', 'main']);
  return root;
}

function cliEnv(): Record<string, string> {
  return {
    ERGO_API_KEY: 'sk-test',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ERGO_PROVIDER: '',
    ERGO_HOME: mkdtempSync(join(tmpdir(), 'ergo-home-')),
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'ergo-xdg-')),
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

function sampleReview(): ReviewResult {
  return {
    summary: {
      summary: 'A change.',
      walkthrough: '',
      fileSummaries: [],
      effort: 3,
      mergeConfidence: 4,
      sequenceDiagram: undefined,
    },
    findings: [
      {
        id: 'ERG-1',
        file: 'a.ts',
        startLine: 1,
        endLine: 1,
        severity: 'minor',
        category: 'correctness',
        title: 'thing',
        description: 'desc',
        rationale: 'why',
        confidence: 0.9,
        codegenInstructions: 'Change X to Y in a.ts line 1.',
      },
    ],
    stats: {
      filesReviewed: 1,
      filesSkipped: 0,
      additions: 1,
      deletions: 0,
      findingsBySeverity: {
        critical: 0,
        major: 0,
        minor: 1,
        suggestion: 0,
        info: 0,
      },
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: 0,
      subscriptionCovered: false,
      model: 'gpt-5.4',
      provider: 'openai',
      durationMs: 1,
    },
  };
}

const DIFF = {
  files: [],
  target: { kind: 'working' as const },
  totalAdditions: 1,
  totalDeletions: 0,
};

describe('inheritance: false ignores the global config', () => {
  async function setup(repoYaml: string) {
    const root = mkdtempSync(join(tmpdir(), 'ergo-inh-'));
    const xdg = mkdtempSync(join(tmpdir(), 'ergo-xdg-'));
    await mkdir(join(xdg, 'ergo'), { recursive: true });
    await writeFile(join(xdg, 'ergo', 'config.yaml'), 'language: fr-FR\n');
    await writeFile(join(root, '.ergo.yaml'), repoYaml);
    return loadConfig(root, {
      XDG_CONFIG_HOME: xdg,
      ERGO_HOME: join(xdg, 'home'),
    } as NodeJS.ProcessEnv);
  }

  test('by default the global config applies', async () => {
    const { config } = await setup('reviews:\n  profile: chill\n');
    expect(config.language).toBe('fr-FR');
  });
  test('inheritance: false drops the global layer', async () => {
    const { config } = await setup(
      'inheritance: false\nreviews:\n  profile: chill\n',
    );
    expect(config.language).toBe('en-US');
  });
});

describe('config resolution for newly wired options', () => {
  test('defaults', () => {
    const { config } = parseConfigString('');
    expect(config?.reviews.typeVerify).toBe(true);
    expect(config?.reviews.wholeRepoContext).toBe(false);
    expect(config?.reviews.historyContext).toBe(false);
    expect(config?.reviews.estimateEffort).toBe(true);
    expect(config?.reviews.mergeConfidence).toBe(true);
    expect(config?.reviews.promptForAiAgents).toBe(false);
    expect(config?.knowledgeBase.seniorReviewers).toEqual([]);
  });
  test('explicit values resolve', () => {
    const { config } = parseConfigString(
      [
        'reviews:',
        '  type_verify: false',
        '  whole_repo_context: true',
        '  history_context: true',
        '  ignore:',
        '    pr_titles: ["^WIP"]',
        '    ignore_usernames: ["bot*"]',
        '    pr_labels: ["skip-review"]',
        'knowledge_base:',
        '  learnings:',
        '    senior_reviewers: ["alice"]',
      ].join('\n'),
    );
    expect(config?.reviews.typeVerify).toBe(false);
    expect(config?.reviews.wholeRepoContext).toBe(true);
    expect(config?.reviews.historyContext).toBe(true);
    expect(config?.reviews.ignorePrTitles).toEqual(['^WIP']);
    expect(config?.reviews.ignoreUsernames).toEqual(['bot*']);
    expect(config?.reviews.ignorePrLabels).toEqual(['skip-review']);
    expect(config?.knowledgeBase.seniorReviewers).toEqual(['alice']);
  });
});

describe('whole-repo and history context gatherers', () => {
  test('gatherFullFileContext returns capped file bodies', async () => {
    const root = await initRepo();
    await writeFile(join(root, 'a.ts'), 'const marker = 42;\n');
    const diffFiles = [
      {
        path: 'a.ts',
        status: 'modified' as const,
        binary: false,
        hunks: [],
        additions: 1,
        deletions: 0,
        language: 'typescript',
      },
    ];
    const out = await gatherFullFileContext(root, diffFiles);
    expect(out).toContain('const marker = 42;');
    expect(out).toContain('a.ts (full file)');
  });

  test('gatherHistoryContext returns commit subjects for the paths', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'add the a module']);
    const out = await gatherHistoryContext(root, [
      {
        path: 'a.ts',
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 1,
        deletions: 0,
        language: 'typescript',
      },
    ]);
    expect(out).toContain('add the a module');
    expect(out).toContain('Test Author');
  });
});

describe('commitMeta', () => {
  test('returns subject and author', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'x\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'WIP: experiment']);
    const meta = await commitMeta('HEAD', root);
    expect(meta?.subject).toBe('WIP: experiment');
    expect(meta?.authorName).toBe('Test Author');
    expect(await commitMeta('not-a-ref', root)).toBeUndefined();
  });
});

describe('--type all: committed + working tree vs base', () => {
  test('collectDiff(all) sees both committed and uncommitted files', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'base.ts'), 'export {};\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await g(['checkout', '-q', '-b', 'feat']);
    await writeFile(join(root, 'committed.ts'), 'const c = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'committed work']);
    await writeFile(join(root, 'uncommitted.ts'), 'const u = 1;\n');

    const all = await collectDiff({ kind: 'all', base: 'main' }, { cwd: root });
    const paths = all.files.map((f) => f.path).sort();
    expect(paths).toEqual(['committed.ts', 'uncommitted.ts']);
    expect(all.base).toBe('main');

    // 'working' only sees the uncommitted file.
    const working = await collectDiff({ kind: 'working' }, { cwd: root });
    expect(working.files.map((f) => f.path)).toEqual(['uncommitted.ts']);
  });
});

describe('pr_titles / ignore_usernames policy skips (e2e)', () => {
  test('a WIP commit subject skips the review', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(
      join(root, '.ergo.yaml'),
      'reviews:\n  ignore:\n    pr_titles: ["^WIP"]\n',
    );
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'WIP: half-done']);

    const out = await exec(
      ['bun', CLI, 'review', '--commit', 'HEAD', '--dir', root],
      { env: cliEnv() },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('pr_titles');
  });

  test('a matching author skips the review', async () => {
    const root = await initRepo();
    const g = gitIn(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    await writeFile(
      join(root, '.ergo.yaml'),
      'reviews:\n  ignore:\n    ignore_usernames: ["Test*"]\n',
    );
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'init']);
    await writeFile(join(root, 'a.ts'), 'const a = 2;\n');
    await g(['add', '.']);
    await g(['commit', '-q', '-m', 'regular change']);

    const out = await exec(
      ['bun', CLI, 'review', '--commit', 'HEAD', '--dir', root],
      { env: cliEnv() },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('ignore_usernames');
  });
});

describe('renderer gates for effort / merge confidence / AI prompts', () => {
  test('terminal shows the assessment line by default and hides when gated off', () => {
    const on = stripAnsi(renderTerminal(sampleReview()));
    expect(on).toContain('effort');
    expect(on).toContain('3/5');
    expect(on).toContain('merge confidence');
    const off = stripAnsi(
      renderTerminal(sampleReview(), { effort: false, mergeConfidence: false }),
    );
    expect(off).not.toContain('effort');
    expect(off).not.toContain('merge confidence');
  });

  test('markdown includes AI prompt blocks only when enabled', () => {
    const off = renderMarkdown(sampleReview(), DIFF);
    expect(off).not.toContain('Prompt for AI agents');
    const on = renderMarkdown(sampleReview(), DIFF, { aiPrompts: true });
    expect(on).toContain('Prompt for AI agents');
    expect(on).toContain('Change X to Y');
    expect(on).toContain('effort 3/5');
  });
});

describe('semver prerelease comparison', () => {
  test('numeric prerelease ids compare numerically', () => {
    expect(compareSemver('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });
});
