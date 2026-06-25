import { describe, expect, test } from 'bun:test';

import { parseConfigString } from '@/config/load';

describe('parseConfigString', () => {
  test('applies defaults for an empty config', () => {
    const r = parseConfigString('');
    expect(r.ok).toBe(true);
    expect(r.config!.reviews.profile).toBe('chill');
    expect(r.config!.reviews.minConfidence).toBe(0.6);
    expect(r.config!.output.defaultFormat).toBe('pretty');
  });

  test('maps cubic sensitivity to profile + confidence', () => {
    const r = parseConfigString('reviews:\n  sensitivity: high\n');
    expect(r.config!.reviews.profile).toBe('assertive');
    expect(r.config!.reviews.minConfidence).toBe(0.5);
  });

  test('honors explicit profile and min_confidence', () => {
    const r = parseConfigString(
      'reviews:\n  profile: assertive\n  min_confidence: 0.8\n',
    );
    expect(r.config!.reviews.profile).toBe('assertive');
    expect(r.config!.reviews.minConfidence).toBe(0.8);
  });

  test('parses path filters and model section', () => {
    const r = parseConfigString(
      [
        'model:',
        '  provider: anthropic',
        '  default: claude-opus-4-8',
        'reviews:',
        '  path_filters:',
        '    - "!dist/**"',
        '    - "src/**"',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
    expect(r.config!.model.provider).toBe('anthropic');
    expect(r.config!.reviews.pathFilters).toEqual(['!dist/**', 'src/**']);
  });

  test('passes through unknown keys without failing', () => {
    const r = parseConfigString('some_future_key:\n  nested: true\n');
    expect(r.ok).toBe(true);
  });

  test('rejects malformed yaml', () => {
    const r = parseConfigString('reviews:\n  profile: [unclosed\n');
    expect(r.ok).toBe(false);
  });

  test('rejects out-of-range confidence', () => {
    const r = parseConfigString('reviews:\n  min_confidence: 5\n');
    expect(r.ok).toBe(false);
  });
});
