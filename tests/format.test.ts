import { describe, expect, test } from 'bun:test';

import { normalizeFormat } from '@/cli/commands/review';

describe('normalizeFormat', () => {
  test('defaults to pretty when no format is given', () => {
    expect(normalizeFormat(undefined)).toBe('pretty');
  });

  test('accepts canonical formats and is case-insensitive', () => {
    expect(normalizeFormat('json')).toBe('json');
    expect(normalizeFormat('SARIF')).toBe('sarif');
    expect(normalizeFormat('Markdown')).toBe('markdown');
  });

  test('resolves aliases', () => {
    expect(normalizeFormat('ndjson')).toBe('agent');
    expect(normalizeFormat('md')).toBe('markdown');
  });

  test('returns null for an unknown format instead of silently using pretty', () => {
    // A typo like `--format jsonn` must surface an error, not corrupt a pipe.
    expect(normalizeFormat('jsonn')).toBeNull();
    expect(normalizeFormat('bogus')).toBeNull();
  });
});
