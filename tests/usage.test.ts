import { describe, expect, test } from 'bun:test';

import { summarizeUsage, type UsageRecord } from '@/memory/usage';

function rec(partial: Partial<UsageRecord>): UsageRecord {
  return {
    ts: '2026-01-01T00:00:00Z',
    repo: '/r',
    model: 'gpt-5.4',
    provider: 'openai',
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    findings: 0,
    subscription: false,
    ...partial,
  };
}

describe('summarizeUsage', () => {
  test('empty input', () => {
    const s = summarizeUsage([]);
    expect(s.reviews).toBe(0);
    expect(s.costUsd).toBe(0);
    expect(s.byModel).toEqual({});
  });

  test('aggregates totals and per-model breakdown', () => {
    const s = summarizeUsage([
      rec({ model: 'gpt-5.4', tokensInput: 100, tokensOutput: 50, costUsd: 0.01, findings: 2 }),
      rec({ model: 'gpt-5.4', tokensInput: 200, tokensOutput: 80, costUsd: 0.02, findings: 1 }),
      rec({ model: 'claude-opus-4-8', costUsd: 0.05, findings: 3 }),
      rec({ model: 'gpt-5.4', subscription: true, findings: 0 }),
    ]);
    expect(s.reviews).toBe(4);
    expect(s.tokensInput).toBe(300);
    expect(s.tokensOutput).toBe(130);
    expect(s.findings).toBe(6);
    expect(s.costUsd).toBeCloseTo(0.08, 10);
    expect(s.subscriptionReviews).toBe(1);
    expect(s.byModel['gpt-5.4']!.reviews).toBe(3);
    expect(s.byModel['claude-opus-4-8']!.reviews).toBe(1);
  });
});
