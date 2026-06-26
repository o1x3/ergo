import { describe, expect, test } from 'bun:test';

import {
  groupThousands,
  hourLabel,
  humanCount,
  humanDuration,
  relativeTime,
  resetsIn,
} from '@/output/format';

describe('humanCount', () => {
  test('compacts large numbers', () => {
    expect(humanCount(999)).toBe('999');
    expect(humanCount(12345)).toBe('12.3K');
    expect(humanCount(1_200_000)).toBe('1.2M');
    expect(humanCount(1_000_000)).toBe('1M');
    expect(humanCount(2_500_000_000)).toBe('2.5B');
  });
});

describe('groupThousands', () => {
  test('inserts separators', () => {
    expect(groupThousands(1234)).toBe('1,234');
    expect(groupThousands(127878)).toBe('127,878');
    expect(groupThousands(0)).toBe('0');
    expect(groupThousands(-4200)).toBe('-4,200');
  });
});

describe('hourLabel', () => {
  test('12-hour clock with AM/PM', () => {
    expect(hourLabel(0)).toBe('12 AM');
    expect(hourLabel(9)).toBe('9 AM');
    expect(hourLabel(12)).toBe('12 PM');
    expect(hourLabel(14)).toBe('2 PM');
    expect(hourLabel(23)).toBe('11 PM');
  });
});

describe('humanDuration', () => {
  test('shows two largest units', () => {
    expect(humanDuration(0)).toBe('now');
    expect(humanDuration(300)).toBe('5m');
    expect(humanDuration(3600 * 3 + 60 * 41)).toBe('3h 41m');
    expect(humanDuration(86_400 * 2 + 3600 * 4)).toBe('2d 4h');
    expect(humanDuration(30)).toBe('<1m');
  });
});

describe('resetsIn', () => {
  test('relative to now', () => {
    const now = 1_700_000_000_000;
    const nowSec = Math.floor(now / 1000);
    expect(resetsIn(nowSec + 3600, now)).toBe('resets in 1h');
    expect(resetsIn(nowSec - 10, now)).toBe('resets now');
    expect(resetsIn(undefined, now)).toBe('reset time unknown');
  });
});

describe('relativeTime', () => {
  test('humanizes the past', () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
