import { describe, expect, test } from 'bun:test';

import pc from 'picocolors';

import { computeDashboard, parseStatsWindow } from '@/memory/stats';
import type { UsageRecord } from '@/memory/usage';
import { renderDashboard } from '@/output/dashboard';
import {
  displayWidth,
  stripAnsi,
  stripControl,
  wrapText,
} from '@/output/style';
import { renderUsage } from '@/output/usage';

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const NOW = new Date(2026, 5, 26, 18).getTime();

// #2/#3/#5 — network-controlled planType must not inject terminal escapes.
describe('usage planType sanitization', () => {
  test('strips control/escape sequences from planType', () => {
    const snap = {
      primary: { usedPercent: 5, windowMinutes: 300, resetsAt: 1782436822 },
      planType: `${ESC}]0;PWNED${BELL}${ESC}[2Jpro`,
      capturedAt: NOW,
    };
    const out = renderUsage(snap, NOW);
    expect(out.includes(BELL)).toBe(false);
    expect(out.includes(`${ESC}]0;`)).toBe(false); // OSC title-set gone
    expect(out.includes(`${ESC}[2J`)).toBe(false); // clear-screen gone
    expect(stripAnsi(out)).toContain('pro plan'); // sanitized text survives
  });
});

// #1/#11 — calendar-month windows must clamp the day at month-ends.
describe('parseStatsWindow month-end clamp', () => {
  test('May 31 − 1mo is Apr 30, not May 1', () => {
    const w = parseStatsWindow('1m', new Date(2026, 4, 31, 12).getTime());
    const since = new Date(w?.sinceMs ?? 0);
    expect(since.getMonth()).toBe(3); // April
    expect(since.getDate()).toBe(30); // clamped (April has 30 days)
  });
  test('Mar 31 − 1mo lands in Feb, never March', () => {
    const w = parseStatsWindow('1m', new Date(2026, 2, 31, 12).getTime());
    const since = new Date(w?.sinceMs ?? 0);
    expect(since.getMonth()).toBe(1); // February
  });
});

// #12 — Trojan-Source bidi/RTL overrides must be stripped.
describe('stripControl removes bidi overrides', () => {
  test('drops RLO / LRO / isolates', () => {
    expect(stripControl('a‮b‪c')).toBe('abc');
    expect(stripControl('x⁦y⁩z')).toBe('xyz');
  });
});

// wrapText must hard-break a single overlong token (no overflow).
describe('wrapText hard-breaks long tokens', () => {
  test('a 100-char unbroken word never exceeds the width', () => {
    for (const line of wrapText('x'.repeat(100), 20)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  // round-2 regression: hard-break must be ANSI-aware (no split escapes / bleed).
  test('hard-breaks a long COLORED token without splitting escapes', () => {
    const c = pc.createColors(true);
    const colored = c.cyan('a'.repeat(130)); // one whitespace-free colored token
    const lines = wrapText(colored, 20);
    for (const line of lines) {
      const plain = stripAnsi(line);
      expect(plain.includes(ESC)).toBe(false); // no truncated/lone CSI survives
      expect(plain).not.toMatch(/\[\d+m/); // no literal "[39m" leaking as text
      expect(displayWidth(line)).toBeLessThanOrEqual(20); // full width (escapes = 0)
    }
    expect(lines.length).toBeGreaterThan(1);
  });
});

// round-2 minor: absurdly large N must be rejected, not yield a NaN window.
describe('parseStatsWindow rejects overflowing N', () => {
  test('returns null instead of sinceMs=NaN', () => {
    expect(parseStatsWindow('999999999999m', NOW)).toBeNull();
    expect(parseStatsWindow('99999999999w', NOW)).toBeNull();
  });
});

function rec(p: Partial<UsageRecord> & { ts: string }): UsageRecord {
  return {
    repo: '/r',
    model: 'gpt-5.4',
    provider: 'codex',
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    findings: 0,
    subscription: true,
    ...p,
  };
}

// #7 — funComparison must never read as a sub-1× multiplier.
describe('funComparison stays ≥ 1×', () => {
  test('1200 tokens (below the smallest reference) shows no comparison', () => {
    const w = parseStatsWindow('all', NOW);
    if (!w) throw new Error('window');
    const dash = computeDashboard(
      [
        rec({
          ts: new Date(2026, 5, 26, 14).toISOString(),
          tokensInput: 800,
          tokensOutput: 400,
        }),
      ],
      w,
      NOW,
    );
    const plain = stripAnsi(renderDashboard(dash, NOW));
    expect(plain).not.toMatch(/~0\.\d×/); // no "~0.7×"
  });
});
