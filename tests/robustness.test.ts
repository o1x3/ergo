import { describe, expect, test } from 'bun:test';

import { parseRateLimitHeaders } from '@/inference/ratelimits';
import { computeDashboard, parseStatsWindow } from '@/memory/stats';
import type { UsageRecord } from '@/memory/usage';
import { renderDashboard } from '@/output/dashboard';
import { displayWidth, stripAnsi } from '@/output/style';
import { renderUsage } from '@/output/usage';

const NOW = new Date(2026, 5, 26, 18).getTime();
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

function win(arg: string) {
  const w = parseStatsWindow(arg, NOW);
  if (!w) throw new Error('window');
  return w;
}

// A grab-bag of hostile usage records: NaN/negative/huge numbers, a bad
// timestamp, a future timestamp, and a model name carrying ANSI + a wide char.
const HOSTILE: UsageRecord[] = [
  {
    ts: 'not-a-date',
    repo: '/r',
    model: 'ok',
    provider: 'codex',
    tokensInput: 10,
    tokensOutput: 5,
    costUsd: 0,
    findings: 1,
    subscription: true,
  },
  {
    ts: new Date(2026, 5, 26, 14).toISOString(),
    repo: '/r',
    model: `${ESC}[31mEVIL${ESC}[0m${BELL}世界`,
    provider: 'codex',
    tokensInput: Number.NaN,
    tokensOutput: -9999,
    costUsd: Number.POSITIVE_INFINITY,
    findings: 2,
    subscription: true,
  },
  {
    ts: new Date(2099, 0, 1).toISOString(), // far future
    repo: '/r',
    model: 'a'.repeat(200), // absurdly long model name
    provider: 'codex',
    tokensInput: 9_999_999_999,
    tokensOutput: 5_000_000,
    costUsd: 0,
    findings: 99999,
    subscription: false,
  },
];

describe('renderDashboard robustness', () => {
  test('does not throw on hostile records', () => {
    expect(() =>
      renderDashboard(computeDashboard(HOSTILE, win('all'), NOW), NOW),
    ).not.toThrow();
  });

  test('never emits raw control chars and stays within width', () => {
    const out = renderDashboard(
      computeDashboard(HOSTILE, win('all'), NOW),
      NOW,
    );
    expect(out.includes(BELL)).toBe(false); // model-supplied bell stripped/contained
    for (const line of out.split('\n')) {
      // long model names / huge numbers must be truncated, not overflow.
      expect(displayWidth(line)).toBeLessThanOrEqual(90);
    }
  });

  test('skips the malformed timestamp but counts the valid rows', () => {
    const d = computeDashboard(HOSTILE, win('all'), NOW);
    expect(d.reviews).toBe(2); // 'not-a-date' dropped
    expect(Number.isFinite(d.totalTokens)).toBe(true); // NaN/Inf coerced to 0
  });
});

describe('renderUsage robustness', () => {
  test('does not throw and clamps a malformed snapshot', () => {
    const snap = {
      primary: { usedPercent: 250, windowMinutes: -5, resetsAt: -1 },
      capturedAt: NOW,
    };
    expect(() => renderUsage(snap, NOW)).not.toThrow();
    const plain = stripAnsi(renderUsage(snap, NOW));
    expect(plain).toContain('100%'); // 250 clamped to 100
  });
});

describe('parseRateLimitHeaders robustness', () => {
  test('tolerates negative / non-numeric / partial headers', () => {
    const h = new Map([
      ['x-codex-primary-used-percent', '-3'],
      ['x-codex-primary-window-minutes', 'NaN'],
      ['x-codex-primary-reset-at', ''],
    ]);
    const snap = parseRateLimitHeaders(
      { get: (k) => h.get(k.toLowerCase()) ?? null },
      NOW,
    );
    expect(snap?.primary?.usedPercent).toBe(0); // negative clamped
    expect(snap?.primary?.windowMinutes).toBeUndefined();
    expect(snap?.primary?.resetsAt).toBeUndefined();
  });
});
