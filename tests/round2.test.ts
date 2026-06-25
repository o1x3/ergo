import { describe, expect, test } from 'bun:test';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPatchToContent } from '@/cli/commands/fix';
import { compareSemver } from '@/cli/commands/update';
import { addLearning, listLearnings, removeLearning } from '@/memory/learnings';
import { type CachedReview, diffSetFromCache } from '@/review/cache';

describe('applyPatchToContent (round-2 hardening)', () => {
  test('preserves mixed line endings of untouched lines', () => {
    const content = 'a\nb\r\nc\n';
    expect(applyPatchToContent(content, 1, 1, 'A')).toBe('A\nb\r\nc\n');
  });

  test('strips a single trailing newline from the patch', () => {
    const content = 'a\nb\nc\n';
    expect(applyPatchToContent(content, 2, 2, 'B\n')).toBe('a\nB\nc\n');
  });

  test('handles EOF without a trailing newline', () => {
    const content = 'a\nb';
    expect(applyPatchToContent(content, 2, 2, 'B')).toBe('a\nB');
  });

  test('multi-line replacement keeps surrounding endings', () => {
    const content = 'x\ny\nz\n';
    expect(applyPatchToContent(content, 2, 2, 'p\nq')).toBe('x\np\nq\nz\n');
  });
});

describe('compareSemver', () => {
  test('orders by major/minor/patch', () => {
    expect(compareSemver('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareSemver('v0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });
  test('prerelease sorts before release', () => {
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0);
  });
  test('does not treat an older latest as an update', () => {
    // current 0.3.0, latest 0.2.0 → not an update
    expect(compareSemver('0.2.0', '0.3.0')).toBeLessThan(0);
  });
});

describe('diffSetFromCache target round-trip', () => {
  function cached(target: string, base?: string, head?: string): CachedReview {
    return {
      version: 1,
      savedAt: 'now',
      repoRoot: '/r',
      context: { target, base, head, files: [], fileHashes: {} },
      review: { summary: {} as never, findings: [], stats: {} as never },
    };
  }
  test('reconstructs staged/branch/commit/range targets', () => {
    expect(diffSetFromCache(cached('staged')).target.kind).toBe('staged');
    const branch = diffSetFromCache(cached('branch', 'main'));
    expect(branch.target).toEqual({ kind: 'branch', base: 'main' });
    const commit = diffSetFromCache(cached('commit', undefined, 'abc'));
    expect(commit.target).toEqual({ kind: 'commit', ref: 'abc' });
    expect(diffSetFromCache(cached('working')).target.kind).toBe('working');
  });
});

describe('learnings: unique ids + targeted removal', () => {
  test('same text gets distinct ids; rm deletes only one', async () => {
    const env = {
      ...process.env,
      ERGO_HOME: mkdtempSync(join(tmpdir(), 'ergo-')),
    };
    const repo = '/fake/repo';
    const a = await addLearning(repo, 'always use parameterized SQL', { env });
    const b = await addLearning(repo, 'always use parameterized SQL', { env });
    expect(a.id).not.toBe(b.id);
    let all = await listLearnings(repo, 'local', env);
    expect(all.length).toBe(2);
    const removed = await removeLearning(repo, a.id, env);
    expect(removed).toBe(true);
    all = await listLearnings(repo, 'local', env);
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe(b.id);
  });
});
