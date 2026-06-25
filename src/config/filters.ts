import { Glob } from 'bun';

const globCache = new Map<string, Glob>();
function glob(pattern: string): Glob {
  let g = globCache.get(pattern);
  if (!g) {
    g = new Glob(pattern);
    globCache.set(pattern, g);
  }
  return g;
}

export function matchesGlob(path: string, pattern: string): boolean {
  try {
    return glob(pattern).match(path);
  } catch {
    return false;
  }
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

// CodeRabbit-style path filters: bare patterns are includes, `!`-prefixed are
// excludes. A path passes if it matches no exclude AND (there are no includes OR
// it matches at least one include).
export function makePathFilter(patterns: string[]): (path: string) => boolean {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const p of patterns) {
    if (p.startsWith('!')) excludes.push(p.slice(1));
    else includes.push(p);
  }
  return (path: string) => {
    if (excludes.some((p) => matchesGlob(path, p))) return false;
    if (includes.length === 0) return true;
    return includes.some((p) => matchesGlob(path, p));
  };
}

// Path-specific instructions: collect instructions whose glob matches the path.
export function instructionsForPath(
  path: string,
  rules: { path: string; instructions: string }[],
): string[] {
  return rules
    .filter((r) => matchesGlob(path, r.path))
    .map((r) => r.instructions);
}
