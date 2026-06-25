import { describe, expect, test } from 'bun:test';

import { getToolByName } from '@/analysis/tools';

const ctx = { repoRoot: '/repo' };

describe('ruff parser', () => {
  test('parses json findings', () => {
    const ruff = getToolByName('ruff')!;
    const out = {
      stdout: JSON.stringify([
        {
          filename: 'a.py',
          location: { row: 3, column: 1 },
          end_location: { row: 3 },
          code: 'F401',
          message: 'unused import',
        },
      ]),
      stderr: '',
      exitCode: 1,
    };
    const f = ruff.parse!(out, ctx);
    expect(f.length).toBe(1);
    expect(f[0]!.ruleId).toBe('F401');
    expect(f[0]!.line).toBe(3);
    expect(f[0]!.tool).toBe('ruff');
  });
});

describe('eslint parser', () => {
  test('maps severity 2 to error', () => {
    const eslint = getToolByName('eslint')!;
    const out = {
      stdout: JSON.stringify([
        {
          filePath: '/repo/a.ts',
          messages: [
            {
              ruleId: 'no-unused-vars',
              severity: 2,
              message: 'x',
              line: 1,
              column: 1,
            },
            { ruleId: 'eqeqeq', severity: 1, message: 'y', line: 2, column: 1 },
          ],
        },
      ]),
      stderr: '',
      exitCode: 1,
    };
    const f = eslint.parse!(out, ctx);
    expect(f.length).toBe(2);
    expect(f[0]!.severity).toBe('error');
    expect(f[1]!.severity).toBe('warning');
  });
});

describe('shellcheck parser', () => {
  test('parses SC codes and levels', () => {
    const sc = getToolByName('shellcheck')!;
    const out = {
      stdout: JSON.stringify([
        {
          file: 's.sh',
          line: 4,
          column: 2,
          level: 'warning',
          code: 2086,
          message: 'quote',
        },
      ]),
      stderr: '',
      exitCode: 1,
    };
    const f = sc.parse!(out, ctx);
    expect(f[0]!.ruleId).toBe('SC2086');
    expect(f[0]!.severity).toBe('warning');
  });
});

describe('mypy parser', () => {
  test('parses text output with codes', () => {
    const mypy = getToolByName('mypy')!;
    const out = {
      stdout:
        'a.py:10:5: error: Incompatible types [assignment]\nb.py:1:1: note: hi',
      stderr: '',
      exitCode: 1,
    };
    const f = mypy.parse!(out, ctx);
    expect(f.length).toBe(2);
    expect(f[0]!.severity).toBe('error');
    expect(f[0]!.ruleId).toBe('assignment');
    expect(f[1]!.severity).toBe('info');
  });
});

describe('semgrep parser', () => {
  test('parses results array', () => {
    const semgrep = getToolByName('semgrep')!;
    const out = {
      stdout: JSON.stringify({
        results: [
          {
            path: 'a.py',
            start: { line: 5, col: 1 },
            end: { line: 6 },
            check_id: 'rule.x',
            extra: { message: 'bad', severity: 'ERROR' },
          },
        ],
      }),
      stderr: '',
      exitCode: 1,
    };
    const f = semgrep.parse!(out, ctx);
    expect(f[0]!.severity).toBe('error');
    expect(f[0]!.ruleId).toBe('rule.x');
  });
});

describe('malformed output', () => {
  test('parsers return [] on junk', () => {
    for (const name of [
      'ruff',
      'eslint',
      'shellcheck',
      'semgrep',
      'hadolint',
    ]) {
      const tool = getToolByName(name)!;
      expect(
        tool.parse!({ stdout: 'not json', stderr: '', exitCode: 1 }, ctx),
      ).toEqual([]);
    }
  });
});
