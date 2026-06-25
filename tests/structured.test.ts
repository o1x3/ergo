import { describe, expect, test } from 'bun:test';

import { extractJson } from '@/inference/structured';

describe('extractJson', () => {
  test('returns plain JSON unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  test('strips ```json fences', () => {
    const text = 'Here:\n```json\n{"a": 1, "b": [2,3]}\n```\nthanks';
    expect(extractJson(text)).toBe('{"a": 1, "b": [2,3]}');
  });

  test('finds object after prose', () => {
    const text = 'Sure! {"findings": []} done';
    expect(extractJson(text)).toBe('{"findings": []}');
  });

  test('handles nested braces and strings with braces', () => {
    const text = '{"msg": "a } b { c", "nested": {"x": 1}}';
    expect(extractJson(text)).toBe(text);
  });

  test('handles arrays', () => {
    expect(extractJson('prefix [1, 2, {"a": 3}] suffix')).toBe(
      '[1, 2, {"a": 3}]',
    );
  });

  test('handles escaped quotes inside strings', () => {
    const text = '{"q": "she said \\"hi\\" }"}';
    expect(extractJson(text)).toBe(text);
  });

  test('returns undefined when no JSON present', () => {
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
  });
});
