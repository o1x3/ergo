import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { instructionsForPath, matchesAny } from '@/config/filters';
import type { ResolvedConfig } from '@/config/schema';
import type { DiffSet, FileDiff } from '@/git/diff';
import { workingFileContent } from '@/git/diff';
import { exec } from '@/util/exec';

const MAX_CONTEXT_FILE_BYTES = 32_000;
const MAX_TOTAL_CONTEXT_BYTES = 80_000;
const MAX_CONTEXT_FILES = 24;

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

const GLOB_CHARS = /[*?[{]/;

// Tracked + untracked-but-not-ignored files (NUL-separated, so odd names
// survive). Untracked matters: a fresh `.cursor/rules/` dir must feed reviews
// before its first commit. `--exclude-standard` keeps ignored trees
// (node_modules, dist) out. Undefined outside a git repo — callers then fall
// back to plain-path patterns only.
async function listRepoFiles(root: string): Promise<string[] | undefined> {
  const { stdout, exitCode } = await exec(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root },
  );
  if (exitCode !== 0) return undefined;
  return stdout.split('\0').filter(Boolean);
}

// Gather repo guideline / agent-context files (AGENTS.md, CLAUDE.md, CONTRIBUTING
// .md, .cursorrules, …) so the reviewer respects house style. Which files are
// read comes from knowledge_base.context_files.patterns and
// knowledge_base.code_guidelines.filePatterns; glob patterns are matched
// against `git ls-files` (tracked files only — node_modules never scanned).
// Capped in file count and total size.
export async function gatherGuidelines(
  repoRoot: string,
  config: ResolvedConfig,
): Promise<string | undefined> {
  const kb = config.knowledgeBase;
  // knowledge_base.opt_out is the master switch for feeding repo knowledge
  // into prompts (learnings are gated on it by the caller).
  if (kb.optOut) return undefined;
  const patterns: string[] = [];
  if (kb.contextFiles.enabled) patterns.push(...kb.contextFiles.patterns);
  if (kb.codeGuidelines.enabled)
    patterns.push(...kb.codeGuidelines.filePatterns);
  if (patterns.length === 0) return undefined;

  const plain = patterns.filter((p) => !GLOB_CHARS.test(p));
  const globs = patterns.filter((p) => GLOB_CHARS.test(p));
  const globMatches = new Set<string>();
  if (globs.length > 0) {
    const repoFiles = await listRepoFiles(repoRoot);
    if (repoFiles) {
      for (const f of repoFiles) {
        if (matchesAny(f, globs)) globMatches.add(f);
      }
    }
  }
  // Explicitly-named files first — the file-count cap must never let a pile
  // of glob matches (e.g. 30 .cursor/rules/*) evict AGENTS.md or CLAUDE.md.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of plain) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  for (const p of [...globMatches].sort()) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }

  const parts: string[] = [];
  let total = 0;
  for (const rel of ordered.slice(0, MAX_CONTEXT_FILES)) {
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
    // The agent applies when at least one changed file is in scope: matching
    // `include` (or no include list) and not matching `exclude`.
    const applies = paths.some((p) => {
      const included =
        !agent.include || agent.include.some((g) => matchSimple(p, g));
      const excluded = (agent.exclude ?? []).some((g) => matchSimple(p, g));
      return included && !excluded;
    });
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

const MAX_FULL_FILE_BYTES = 24_000;
const MAX_TOTAL_FULL_FILE_BYTES = 96_000;

// reviews.whole_repo_context: the full current content of each changed file so
// the model sees the surrounding code, not just hunks. Working-tree targets
// only (the worktree is what's under review). Budget-capped.
export async function gatherFullFileContext(
  repoRoot: string,
  files: FileDiff[],
): Promise<string | undefined> {
  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    if (f.binary) continue;
    const content = await workingFileContent(repoRoot, f.path);
    if (!content?.trim()) continue;
    const capped =
      content.length > MAX_FULL_FILE_BYTES
        ? `${content.slice(0, MAX_FULL_FILE_BYTES)}\n…[truncated]`
        : content;
    const block = `### ${f.path} (full file)\n${capped}`;
    if (total + block.length > MAX_TOTAL_FULL_FILE_BYTES) break;
    parts.push(block);
    total += block.length;
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

const HISTORY_COMMITS = 20;
const MAX_HISTORY_CHARS = 4_000;

// reviews.history_context: recent commit subjects touching the changed paths,
// so the model knows how this area has been evolving.
export async function gatherHistoryContext(
  repoRoot: string,
  files: FileDiff[],
): Promise<string | undefined> {
  if (files.length === 0) return undefined;
  const { stdout, exitCode } = await exec(
    [
      'git',
      'log',
      `-n${HISTORY_COMMITS}`,
      '--no-merges',
      '--pretty=format:- %s (%an)',
      '--',
      ...files.map((f) => f.path),
    ],
    { cwd: repoRoot },
  );
  if (exitCode !== 0) return undefined;
  const text = stdout.trim();
  return text ? text.slice(0, MAX_HISTORY_CHARS) : undefined;
}
