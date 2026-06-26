import { describe, expect, test } from 'bun:test';
import {
  computeDashboard,
  ordinalToParts,
  parseStatsWindow,
} from '@/memory/stats';
import type { UsageRecord } from '@/memory/usage';
import {
  chip,
  confMeter,
  gauge,
  hbar,
  heatmap,
  section,
  sevGlyph,
  statColumns,
} from '@/output/layout';
import { displayWidth, stripAnsi } from '@/output/style';

describe('chip / sevGlyph / confMeter', () => {
  test('chip has no interior padding (visible width = word)', () => {
    expect(stripAnsi(chip('CRITICAL', 'critical'))).toBe('CRITICAL');
    expect(displayWidth(chip('MINOR', 'minor'))).toBe(5);
  });
  test('sevGlyph shape encodes severity (1 column)', () => {
    expect(stripAnsi(sevGlyph('critical'))).toBe('◆');
    expect(stripAnsi(sevGlyph('minor'))).toBe('●');
    expect(stripAnsi(sevGlyph('info'))).toBe('○');
    expect(displayWidth(sevGlyph('critical'))).toBe(1);
  });
  test('confMeter fills round(conf*5)', () => {
    expect(stripAnsi(confMeter(0.62))).toBe('●●●○○');
    expect(stripAnsi(confMeter(0))).toBe('○○○○○');
    expect(stripAnsi(confMeter(1))).toBe('●●●●●');
    expect(displayWidth(confMeter(0.5))).toBe(5);
  });
});

describe('gauge / hbar', () => {
  test('gauge bar is exactly `width` columns and clamps', () => {
    expect(displayWidth(gauge(37, 20, { showPct: false }))).toBe(20);
    expect(stripAnsi(gauge(0, 10, { showPct: false }))).toBe('░'.repeat(10));
    expect(stripAnsi(gauge(100, 10, { showPct: false }))).toBe('█'.repeat(10));
    expect(stripAnsi(gauge(150, 10, { showPct: false }))).toBe('█'.repeat(10));
  });
  test('hbar fills the fraction and stays `width` wide', () => {
    expect(displayWidth(hbar(0.5, 20))).toBe(20);
    expect(stripAnsi(hbar(0, 8))).toBe('░'.repeat(8));
    expect(stripAnsi(hbar(2, 8))).toBe('█'.repeat(8)); // clamps >1
  });
});

describe('section', () => {
  test('right-aligns the note and appends a rule', () => {
    const [header, hr] = section('Findings', {
      width: 30,
      right: '2 found',
      rule: true,
    });
    expect(displayWidth(header ?? '')).toBe(30);
    expect(stripAnsi(header ?? '')).toMatch(/^Findings +2 found$/);
    expect(stripAnsi(hr ?? '')).toBe('─'.repeat(30));
  });
});

describe('heatmap', () => {
  test('returns a month line + 7 weekday rows, contiguous cells', () => {
    const lines = heatmap({ '2026-06-26': 3 }, new Date(2026, 5, 26), 4);
    expect(lines).toHaveLength(8);
    // each weekday row: 4-char gutter + 4 contiguous cells
    for (const row of lines.slice(1)) {
      expect(displayWidth(row)).toBe(8);
    }
  });
});

describe('statColumns', () => {
  test('label / value / sub rows align across columns', () => {
    const [labels, values, subs] = statColumns(
      [
        { label: 'REVIEWS', value: '142', sub: '3.7 / day' },
        { label: 'TOKENS', value: '1.2M', sub: '843K in' },
      ],
      16,
      2,
    );
    expect(stripAnsi(labels ?? '')).toContain('REVIEWS');
    expect(stripAnsi(values ?? '')).toContain('142');
    expect(stripAnsi(subs ?? '')).toContain('3.7 / day');
  });
});

describe('parseStatsWindow calendar months vs days', () => {
  const now = new Date(2026, 5, 26, 12).getTime();
  test('1m is a calendar month, distinct from 30d', () => {
    const m = parseStatsWindow('1m', now);
    const d = parseStatsWindow('30d', now);
    expect(m?.label).toBe('last 1 month');
    expect(d?.label).toBe('last 30 days');
    // calendar month back from Jun 26 = May 26; 30 days back = May 27 → distinct.
    expect(m?.sinceMs).not.toBe(d?.sinceMs);
  });
});

function rec(p: Partial<UsageRecord> & { ts: string }): UsageRecord {
  return {
    repo: '/r',
    model: 'gpt-5.4',
    provider: 'codex',
    tokensInput: 10,
    tokensOutput: 5,
    costUsd: 0,
    findings: 0,
    subscription: true,
    ...p,
  };
}

describe('longest-streak date range', () => {
  test('captures the inclusive bounds of the longest run', () => {
    const now = new Date(2026, 5, 26, 12).getTime();
    const at = (mo: number, d: number) =>
      new Date(2026, mo - 1, d, 12).toISOString();
    const win = parseStatsWindow('all', now);
    if (!win) throw new Error('window');
    // a 3-day run Apr 6–8, plus an isolated day.
    const dash = computeDashboard(
      [
        rec({ ts: at(4, 6) }),
        rec({ ts: at(4, 7) }),
        rec({ ts: at(4, 8) }),
        rec({ ts: at(2, 1) }),
      ],
      win,
      now,
    );
    expect(dash.longestStreak).toBe(3);
    const s = ordinalToParts(dash.longestStreakStartOrd ?? 0);
    const e = ordinalToParts(dash.longestStreakEndOrd ?? 0);
    expect(s.month).toBe(3); // April (0-based)
    expect(s.day).toBe(6);
    expect(e.day).toBe(8);
  });
});
