import { describe, expect, test } from 'bun:test';

import { estimateCostUsd, lookupPricing } from '@/inference/models';

describe('estimateCostUsd', () => {
  test('openai-style: input includes cached, so cached is subtracted once', () => {
    // gpt-5.4: input $2.5, output $15, cacheRead $0.25 per 1M
    const cost = estimateCostUsd(
      'gpt-5.4',
      { input: 1000, output: 500, cacheRead: 400 },
      { provider: 'openai' },
    );
    // fresh = 600*2.5 + cached 400*0.25 + out 500*15, /1e6
    const expected = (600 * 2.5 + 400 * 0.25 + 500 * 15) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  test('anthropic-style: input excludes cached, so it is NOT subtracted', () => {
    const cost = estimateCostUsd(
      'claude-opus-4-8',
      { input: 1000, output: 500, cacheRead: 400, cacheWrite: 100 },
      { provider: 'anthropic' },
    );
    const p = lookupPricing('claude-opus-4-8')!;
    const writeRate = p.cacheWrite ?? p.input * 1.25;
    const expected =
      (1000 * p.input +
        400 * (p.cacheRead ?? p.input) +
        100 * writeRate +
        500 * p.output) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  test('returns undefined for unknown model or no usage', () => {
    expect(estimateCostUsd('nope', { input: 1, output: 1 })).toBeUndefined();
    expect(estimateCostUsd('gpt-5.4', undefined)).toBeUndefined();
  });

  test('date-suffixed model names resolve to base pricing', () => {
    expect(lookupPricing('claude-haiku-4-5-20251001')).toBeDefined();
  });
});
