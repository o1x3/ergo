import { describe, expect, test } from 'bun:test';

import { computeDashboard, parseStatsWindow } from '@/memory/stats';
import type { UsageRecord } from '@/memory/usage';
import { renderDashboard } from '@/output/dashboard';
import { displayWidth, stripAnsi } from '@/output/style';
import { renderUsage } from '@/output/usage';

const NOW = new Date(2026, 5, 26, 18).getTime();

function win(arg: string) {
  const w = parseStatsWindow(arg, NOW);
  if (!w) throw new Error(`bad window ${arg}`);
  return w;
}

function rec(p: Partial<UsageRecord> & { ts: string }): UsageRecord {
  return {
    repo: '/r',
    model: 'gpt-5.4',
    provider: 'codex',
    tokensInput: 20_000,
    tokensOutput: 8_000,
    costUsd: 0,
    findings: 2,
    subscription: true,
    ...p,
  };
}

describe('renderDashboard', () => {
  const at = (d: number, h = 14) => new Date(2026, 5, d, h).toISOString();
  const dash = computeDashboard(
    [rec({ ts: at(24) }), rec({ ts: at(25) }), rec({ ts: at(26) })],
    win('all'),
    NOW,
  );

  test('includes the stat cards, heatmap, and fun line', () => {
    const plain = stripAnsi(renderDashboard(dash, NOW));
    expect(plain).toContain('ergo stats');
    expect(plain).toContain('all time');
    expect(plain).toContain('REVIEWS');
    expect(plain).toContain('CURRENT STREAK'); // not truncated
    expect(plain).toContain('ACTIVITY');
    expect(plain).toContain('MODELS');
    expect(plain).toContain('Mon');
    expect(plain).toMatch(/burned ~[\d.]+× the tokens/);
  });

  test('card labels are never truncated by width', () => {
    const plain = stripAnsi(renderDashboard(dash, NOW));
    expect(plain).not.toContain('STRE…');
  });

  test('empty data shows a friendly message, no cards', () => {
    const empty = computeDashboard([], win('all'), NOW);
    const plain = stripAnsi(renderDashboard(empty, NOW));
    expect(plain).toContain('No reviews recorded');
    expect(plain).not.toContain('REVIEWS');
  });

  test('window arg appears in the header', () => {
    const sevenDay = computeDashboard([rec({ ts: at(26) })], win('7d'), NOW);
    expect(stripAnsi(renderDashboard(sevenDay, NOW))).toContain('last 7 days');
  });
});

describe('renderUsage', () => {
  const snap = {
    primary: { usedPercent: 37, windowMinutes: 300, resetsAt: 1782436822 },
    secondary: { usedPercent: 12, windowMinutes: 10080, resetsAt: 1783023622 },
    planType: 'plus',
    capturedAt: 1782423543228,
  };

  test('renders a gauge per window with reset times', () => {
    const plain = stripAnsi(renderUsage(snap, 1782423543228));
    expect(plain).toContain('ergo usage');
    expect(plain).toContain('plus plan');
    expect(plain).toContain('5h limit');
    expect(plain).toContain('weekly limit');
    expect(plain).toContain('37%');
    expect(plain).toContain('resets in');
    expect(plain).toContain('% remaining');
  });

  test('no-data state is friendly', () => {
    const plain = stripAnsi(renderUsage(undefined, Date.now()));
    expect(plain).toContain('No rate-limit data yet');
    expect(plain).not.toContain('5h limit');
  });

  test('omits the plan suffix when planType is absent', () => {
    const noPlan = { ...snap, planType: undefined };
    expect(stripAnsi(renderUsage(noPlan, snap.capturedAt))).not.toContain(
      'plan',
    );
  });
});

describe('layout width safety', () => {
  test('no dashboard line exceeds a sane terminal width', () => {
    const at = (d: number) => new Date(2026, 5, d, 14).toISOString();
    const dash = computeDashboard(
      [rec({ ts: at(26), tokensInput: 9_000_000 })],
      win('all'),
      NOW,
    );
    for (const line of renderDashboard(dash, NOW).split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(90);
    }
  });
});
