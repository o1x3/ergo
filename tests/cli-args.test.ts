import { describe, expect, test } from 'bun:test';

import { withDefaultCommand } from '@/cli/args';
import { applyPatchToContent } from '@/cli/commands/fix';

describe('withDefaultCommand', () => {
  test('bare invocation runs review', () => {
    expect(withDefaultCommand([])).toEqual(['review']);
  });
  test('leading flags imply review', () => {
    expect(withDefaultCommand(['--base', 'main'])).toEqual([
      'review',
      '--base',
      'main',
    ]);
  });
  test('known commands pass through', () => {
    expect(withDefaultCommand(['auth', 'login'])).toEqual(['auth', 'login']);
    expect(withDefaultCommand(['doctor'])).toEqual(['doctor']);
  });
  test('unknown first token implies review', () => {
    expect(withDefaultCommand(['HEAD~1'])).toEqual(['review', 'HEAD~1']);
  });
  test('review findings routes to top-level findings', () => {
    expect(withDefaultCommand(['review', 'findings'])).toEqual(['findings']);
    expect(
      withDefaultCommand(['review', 'findings', '--format', 'json']),
    ).toEqual(['findings', '--format', 'json']);
  });
  test('help/version pass through', () => {
    expect(withDefaultCommand(['--help'])).toEqual(['--help']);
    expect(withDefaultCommand(['--version'])).toEqual(['--version']);
  });
});

describe('applyPatchToContent', () => {
  const file = 'line1\nline2\nline3\nline4\n';

  test('replaces a single line', () => {
    expect(applyPatchToContent(file, 2, 2, 'LINE2')).toBe(
      'line1\nLINE2\nline3\nline4\n',
    );
  });

  test('replaces a range with multiple lines', () => {
    expect(applyPatchToContent(file, 2, 3, 'a\nb\nc')).toBe(
      'line1\na\nb\nc\nline4\n',
    );
  });

  test('rejects out-of-range', () => {
    expect(applyPatchToContent(file, 0, 1, 'x')).toBeUndefined();
    expect(applyPatchToContent(file, 3, 99, 'x')).toBeUndefined();
    expect(applyPatchToContent(file, 3, 2, 'x')).toBeUndefined();
  });

  test('preserves CRLF line endings', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    expect(applyPatchToContent(crlf, 2, 2, 'B')).toBe('a\r\nB\r\nc\r\n');
  });
});
