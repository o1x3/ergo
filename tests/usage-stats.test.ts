import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type HeaderLike,
  parseRateLimitHeaders,
  windowLabel,
} from '@/inference/ratelimits';
import { readRateLimits, saveRateLimits } from '@/memory/ratelimits';
import { computeDashboard, parseStatsWindow } from '@/memory/stats';
import type { UsageRecord } from '@/memory/usage';

function headers(obj: Record<string, string>): HeaderLike {
  const m = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => m.get(name.toLowerCase()) ?? null };
}

describe('parseRateLimitHeaders', () => {
  test('parses both windows from real Codex headers', () => {
    const snap = parseRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '3',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1782436822',
        'x-codex-secondary-used-percent': '0',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1783023622',
      }),
      1_700_000_000_000,
    );
    expect(snap?.primary).toEqual({
      usedPercent: 3,
      windowMinutes: 300,
      resetsAt: 1782436822,
    });
    expect(snap?.secondary?.windowMinutes).toBe(10080);
    expect(snap?.capturedAt).toBe(1_700_000_000_000);
  });

  test('returns undefined when no rate-limit headers present', () => {
    expect(
      parseRateLimitHeaders(headers({ 'content-type': 'x' })),
    ).toBeUndefined();
  });

  test('clamps used-percent to 0-100', () => {
    const snap = parseRateLimitHeaders(
      headers({ 'x-codex-primary-used-percent': '150' }),
    );
    expect(snap?.primary?.usedPercent).toBe(100);
  });

  test('falls back to reset-after-seconds when reset-at is absent', () => {
    const captured = 1_700_000_000_000;
    const snap = parseRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '10',
        'x-codex-primary-reset-after-seconds': '3600',
      }),
      captured,
    );
    expect(snap?.primary?.resetsAt).toBe(Math.floor(captured / 1000) + 3600);
  });

  test('ignores non-numeric headers without throwing', () => {
    const snap = parseRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-window-minutes': 'garbage',
      }),
    );
    expect(snap?.primary?.usedPercent).toBe(5);
    expect(snap?.primary?.windowMinutes).toBeUndefined();
  });
});

describe('windowLabel', () => {
  test('maps known windows', () => {
    expect(windowLabel(300)).toBe('5h');
    expect(windowLabel(1440)).toBe('daily');
    expect(windowLabel(10080)).toBe('weekly');
    expect(windowLabel(43200)).toBe('monthly');
  });
  test('tolerates ±5% drift', () => {
    expect(windowLabel(295)).toBe('5h');
    expect(windowLabel(10300)).toBe('weekly');
  });
  test('falls back for unknown / invalid', () => {
    expect(windowLabel(undefined)).toBe('usage');
    expect(windowLabel(0)).toBe('usage');
    expect(windowLabel(120)).toBe('2h');
  });
});

describe('parseStatsWindow', () => {
  const now = new Date(2026, 5, 26, 12).getTime();
  test('all-time for empty/all', () => {
    expect(parseStatsWindow(undefined, now)?.arg).toBe('all');
    expect(parseStatsWindow('all', now)?.sinceMs).toBeUndefined();
  });
  test('parses Nd / Nw / Nm', () => {
    expect(parseStatsWindow('7d', now)?.label).toBe('last 7 days');
    expect(parseStatsWindow('2w', now)?.label).toBe('last 2 weeks');
    expect(parseStatsWindow('1m', now)?.label).toBe('last 1 month');
  });
  test('rejects garbage', () => {
    expect(parseStatsWindow('xyz', now)).toBeNull();
    expect(parseStatsWindow('0d', now)).toBeNull();
    expect(parseStatsWindow('7', now)).toBeNull();
  });
});

function rec(p: Partial<UsageRecord> & { ts: string }): UsageRecord {
  return {
    repo: '/r',
    model: 'gpt-5.4',
    provider: 'codex',
    tokensInput: 100,
    tokensOutput: 50,
    costUsd: 0,
    findings: 1,
    subscription: true,
    ...p,
  };
}

describe('computeDashboard', () => {
  const at = (y: number, mo: number, d: number, h = 12) =>
    new Date(y, mo - 1, d, h).toISOString();

  test('aggregates reviews, tokens, findings, models', () => {
    const now = new Date(2026, 5, 26, 18).getTime();
    const records = [
      rec({ ts: at(2026, 6, 26, 14), findings: 2 }),
      rec({ ts: at(2026, 6, 26, 14), model: 'gpt-5.4-mini', findings: 0 }),
      rec({ ts: at(2026, 6, 25, 9), findings: 1 }),
    ];
    const d = computeDashboard(records, parseStatsWindow('all', now)!, now);
    expect(d.reviews).toBe(3);
    expect(d.findings).toBe(3);
    expect(d.totalTokens).toBe(450);
    expect(d.activeDays).toBe(2);
    expect(d.peakHour).toBe(14);
    expect(d.peakHourCount).toBe(2);
    expect(d.topModel).toBe('gpt-5.4');
    expect(d.topModelReviews).toBe(2);
    expect(d.byDay['2026-06-26']).toBe(2);
  });

  test('computes consecutive-day streaks', () => {
    const now = new Date(2026, 5, 26, 18).getTime();
    const records = [
      rec({ ts: at(2026, 6, 24) }),
      rec({ ts: at(2026, 6, 25) }),
      rec({ ts: at(2026, 6, 26) }),
      rec({ ts: at(2026, 6, 20) }), // gap before the run
    ];
    const d = computeDashboard(records, parseStatsWindow('all', now)!, now);
    expect(d.activeDays).toBe(4);
    expect(d.longestStreak).toBe(3);
    expect(d.currentStreak).toBe(3);
  });

  test('current streak uses yesterday grace when today is inactive', () => {
    const now = new Date(2026, 5, 26, 9).getTime(); // today, no review yet
    const records = [
      rec({ ts: at(2026, 6, 24) }),
      rec({ ts: at(2026, 6, 25) }),
    ];
    const d = computeDashboard(records, parseStatsWindow('all', now)!, now);
    expect(d.currentStreak).toBe(2);
  });

  test('window filters out older records', () => {
    const now = new Date(2026, 5, 26, 18).getTime();
    const records = [
      rec({ ts: at(2026, 6, 26) }),
      rec({ ts: at(2026, 6, 1) }), // outside 7d
    ];
    const d = computeDashboard(records, parseStatsWindow('7d', now)!, now);
    expect(d.reviews).toBe(1);
  });

  test('empty records produce a zeroed dashboard', () => {
    const now = Date.now();
    const d = computeDashboard([], parseStatsWindow('all', now)!, now);
    expect(d.reviews).toBe(0);
    expect(d.currentStreak).toBe(0);
    expect(d.peakHour).toBeUndefined();
    expect(d.topModel).toBeUndefined();
  });
});

describe('rate-limit persistence round-trip', () => {
  test('saves and reads back the latest snapshot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ergo-rl-'));
    const env = { ...process.env, ERGO_HOME: home };
    const snap = {
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1782436822 },
      secondary: { usedPercent: 4, windowMinutes: 10080, resetsAt: 1783023622 },
      capturedAt: 1_700_000_000_000,
    };
    await saveRateLimits(snap, env);
    expect(await readRateLimits(env)).toEqual(snap);
  });

  test('readRateLimits returns undefined when no file exists', async () => {
    const env = {
      ...process.env,
      ERGO_HOME: join(tmpdir(), 'ergo-rl-missing-xyz'),
    };
    expect(await readRateLimits(env)).toBeUndefined();
  });
});
