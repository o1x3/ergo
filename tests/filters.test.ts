import { describe, expect, test } from 'bun:test';

import { instructionsForPath, makePathFilter } from '@/config/filters';

describe('makePathFilter', () => {
  test('excludes with ! patterns', () => {
    const f = makePathFilter(['!dist/**', '!**/*.lock']);
    expect(f('src/index.ts')).toBe(true);
    expect(f('dist/index.js')).toBe(false);
    expect(f('bun.lock')).toBe(false);
  });

  test('includes require a match when present', () => {
    const f = makePathFilter(['src/**']);
    expect(f('src/a.ts')).toBe(true);
    expect(f('test/a.ts')).toBe(false);
  });

  test('exclude wins over include', () => {
    const f = makePathFilter(['src/**', '!src/generated/**']);
    expect(f('src/a.ts')).toBe(true);
    expect(f('src/generated/x.ts')).toBe(false);
  });

  test('empty filter allows everything', () => {
    const f = makePathFilter([]);
    expect(f('anything')).toBe(true);
  });
});

describe('instructionsForPath', () => {
  test('returns instructions whose glob matches', () => {
    const rules = [
      { path: 'src/**/*.ts', instructions: 'strict null' },
      { path: '**/*.sql', instructions: 'no raw sql' },
    ];
    expect(instructionsForPath('src/a/b.ts', rules)).toEqual(['strict null']);
    expect(instructionsForPath('db/x.sql', rules)).toEqual(['no raw sql']);
    expect(instructionsForPath('README.md', rules)).toEqual([]);
  });
});
