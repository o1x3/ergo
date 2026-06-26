import { describe, expect, test } from 'bun:test';

import pc from 'picocolors';

import {
  center,
  displayWidth,
  padEnd,
  padStart,
  stripAnsi,
  truncate,
} from '@/output/style';

// Force-build a colored string regardless of TTY/NO_COLOR so the ANSI-aware
// assertions are deterministic. createColors(true) always emits escapes.
const c = pc.createColors(true);

describe('stripAnsi / displayWidth', () => {
  test('color codes do not count toward width', () => {
    const colored = c.bold(c.cyan('hello'));
    expect(colored).not.toBe('hello'); // really has escapes
    expect(stripAnsi(colored)).toBe('hello');
    expect(displayWidth(colored)).toBe(5);
  });

  test('plain ascii width is length', () => {
    expect(displayWidth('142 reviews')).toBe(11);
  });

  test('wide glyphs count as two columns', () => {
    expect(displayWidth('🔴')).toBe(2);
    expect(displayWidth('世界')).toBe(4);
  });

  test('no orphaned ESC bytes after stripping', () => {
    const stripped = stripAnsi(c.red('x'));
    expect(stripped).toBe('x');
    expect(stripped.includes(String.fromCharCode(27))).toBe(false);
  });
});

describe('padEnd / padStart / center align by visible width', () => {
  test('padEnd accounts for color codes', () => {
    const padded = padEnd(c.green('ok'), 6);
    expect(displayWidth(padded)).toBe(6);
    expect(stripAnsi(padded)).toBe('ok    ');
  });
  test('padStart right-aligns', () => {
    expect(stripAnsi(padStart('7', 4))).toBe('   7');
  });
  test('center splits padding', () => {
    expect(stripAnsi(center('ab', 6))).toBe('  ab  ');
  });
  test('no padding when already wide enough', () => {
    expect(padEnd('toolong', 3)).toBe('toolong');
  });
});

describe('truncate', () => {
  test('keeps short strings unchanged', () => {
    expect(truncate('short', 10)).toBe('short');
  });
  test('truncates with ellipsis by visible width', () => {
    const out = truncate('abcdefghij', 5);
    expect(displayWidth(out)).toBe(5);
    expect(out).toBe('abcd…');
  });
  test('preserves color codes while truncating', () => {
    const out = truncate(c.cyan('abcdefghij'), 5);
    expect(displayWidth(out)).toBe(5);
    expect(stripAnsi(out)).toBe('abcd…');
    expect(out.includes(String.fromCharCode(27))).toBe(true); // color survived
  });
});
