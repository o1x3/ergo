import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { instructionsForPath } from '@/config/filters';
import type { ResolvedConfig } from '@/config/schema';
import type { DiffSet } from '@/git/diff';

const MAX_CONTEXT_FILE_BYTES = 32_000;
const MAX_TOTAL_CONTEXT_BYTES = 80_000;

async function readCapped(
  path: string,
  cap: number,
): Promise<string | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    return content.length > cap
      ? `${content.slice(0, cap)}\n…[truncated]`
      : content;
  } catch {
    return undefined;
  }
}

// Gather repo guideline / agent-context files (AGENTS.md, CLAUDE.md, CONTRIBUTING
// .md, .cursorrules, …) so the reviewer respects house style. Capped in size.
export async function gatherGuidelines(
  repoRoot: string,
  config: ResolvedConfig,
): Promise<string | undefined> {
  if (!config.knowledgeBase.codeGuidelines.enabled) return undefined;
  // We resolve a small set of well-known files directly (fast, predictable)
  // rather than globbing the whole tree.
  const wellKnown = [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    '.cursorrules',
    '.ergo/guidelines.md',
  ];
  const parts: string[] = [];
  let total = 0;
  for (const rel of wellKnown) {
    const content = await readCapped(
      join(repoRoot, rel),
      MAX_CONTEXT_FILE_BYTES,
    );
    if (content?.trim()) {
      const block = `--- ${rel} ---\n${content.trim()}`;
      // Skip files that would overflow the budget, but keep checking smaller
      // later files instead of stopping at the first oversized one.
      if (total + block.length > MAX_TOTAL_CONTEXT_BYTES) continue;
      parts.push(block);
      total += block.length;
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

// Collect path-specific instructions relevant to the files in this diff.
export function gatherPathInstructions(
  diff: DiffSet,
  config: ResolvedConfig,
): string | undefined {
  if (config.reviews.pathInstructions.length === 0) return undefined;
  const lines: string[] = [];
  for (const file of diff.files) {
    const ins = instructionsForPath(file.path, config.reviews.pathInstructions);
    for (const i of ins) lines.push(`- ${file.path}: ${i}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

// Fold enabled custom agents (cubic-style NL rules) into a single instruction
// block scoped to the files they include/exclude.
export function gatherCustomAgents(
  diff: DiffSet,
  config: ResolvedConfig,
): string | undefined {
  const enabled = config.reviews.customAgents.filter(
    (a) => a.enabled !== false,
  );
  if (enabled.length === 0) return undefined;
  const paths = diff.files.map((f) => f.path);
  const lines: string[] = [];
  for (const agent of enabled) {
    const applies =
      !agent.include ||
      paths.some((p) => (agent.include ?? []).some((g) => matchSimple(p, g)));
    if (!applies) continue;
    lines.push(`- [${agent.name}] ${agent.instructions}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function matchSimple(path: string, pattern: string): boolean {
  try {
    return new Bun.Glob(pattern).match(path);
  } catch {
    return false;
  }
}
