import { describe, expect, test } from 'bun:test';

import {
  buildCodexInput,
  fetchCodexWithRetry,
  isRetryableStatus,
  parseRetryAfter,
  resolveCodexUrl,
} from '@/inference/codex-client';

describe('parseRetryAfter', () => {
  test('parses seconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
  });
  test('parses HTTP date', () => {
    const now = Date.now();
    const future = new Date(now + 5000).toUTCString();
    const ms = parseRetryAfter(future, now);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(0);
  });
  test('returns null for junk', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
  });
});

describe('isRetryableStatus', () => {
  test('429 and 5xx are retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });
  test('4xx (non-429) and 2xx are not', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('resolveCodexUrl', () => {
  test('appends codex/responses', () => {
    expect(resolveCodexUrl('https://x.com/backend-api')).toBe(
      'https://x.com/backend-api/codex/responses',
    );
  });
  test('is idempotent', () => {
    expect(resolveCodexUrl('https://x.com/codex/responses')).toBe(
      'https://x.com/codex/responses',
    );
  });
  test('handles trailing slashes', () => {
    expect(resolveCodexUrl('https://x.com/codex/')).toBe(
      'https://x.com/codex/responses',
    );
  });
});

describe('buildCodexInput', () => {
  test('skips system and maps roles', () => {
    const input = buildCodexInput([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    expect(input.length).toBe(2);
    expect(input[0]!.role).toBe('user');
    expect(input[0]!.content[0]!.type).toBe('input_text');
    expect(input[1]!.content[0]!.type).toBe('output_text');
  });
});

describe('fetchCodexWithRetry', () => {
  test('retries on 429 then succeeds', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response('rate', { status: 429 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchCodexWithRetry(
      fakeFetch,
      'https://x',
      { method: 'POST' },
      { sleep: async () => {}, random: () => 0 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  test('does not retry on 400', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response('bad', { status: 400 });
    }) as unknown as typeof fetch;
    const res = await fetchCodexWithRetry(
      fakeFetch,
      'https://x',
      { method: 'POST' },
      { sleep: async () => {} },
    );
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });
});
