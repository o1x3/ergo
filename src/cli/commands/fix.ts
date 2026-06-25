import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { defineCommand } from 'citty';

import { isGitRepo, repoRoot } from '@/git/repo';
import { loadReviewCache } from '@/review/cache';
import type { ReviewFinding } from '@/review/schema';
import { log, pc } from '@/util/logger';
import { confirm } from '@/util/prompt';

type ApplyResult = { id: string; file: string; ok: boolean; reason?: string };

// Replace lines [startLine, endLine] (1-based, inclusive) with `patch`.
export function applyPatchToContent(
  content: string,
  startLine: number,
  endLine: number,
  patch: string,
): string | undefined {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    return undefined;
  }
  const replacement = patch.replace(/\r?\n/g, eol).split(eol);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
  return lines.join(eol);
}

export const fixCommand = defineCommand({
  meta: {
    name: 'fix',
    description:
      'Apply suggested fixes from the last review to the working tree',
  },
  args: {
    id: {
      type: 'string',
      description: 'Comma-separated finding ids to apply (e.g. ERG-1,ERG-3)',
    },
    all: {
      type: 'boolean',
      description: 'Apply every finding that has a patch',
    },
    dir: { type: 'string', description: 'Path to the git repo' },
    yes: { type: 'boolean', alias: 'y', description: 'Skip confirmation' },
  },
  async run({ args }) {
    const cwd = args.dir ? resolvePath(args.dir as string) : process.cwd();
    const root = (await isGitRepo(cwd)) ? await repoRoot(cwd) : cwd;
    const cached = await loadReviewCache(root);
    if (!cached) {
      log.error('No cached review found. Run `ergo review` first.');
      process.exitCode = 1;
      return;
    }

    const wanted = (args.id as string | undefined)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = cached.review.findings.filter(
      (f) => f.suggestedPatch?.trim() && (args.all || wanted?.includes(f.id)),
    );

    if (!args.all && !wanted) {
      // Show what is fixable.
      const fixable = cached.review.findings.filter((f) =>
        f.suggestedPatch?.trim(),
      );
      if (fixable.length === 0) {
        log.info('No findings in the last review include a suggested patch.');
        return;
      }
      log.info('Findings with applicable fixes:');
      for (const f of fixable) {
        log.raw(
          `  ${pc.bold(f.id)} ${pc.dim(`${f.file}:${f.startLine}`)} ${f.title}`,
        );
      }
      log.info('');
      log.info('Apply with `ergo fix --id ERG-1,ERG-2` or `ergo fix --all`.');
      return;
    }

    if (candidates.length === 0) {
      log.error('No matching findings with a suggested patch.');
      process.exitCode = 1;
      return;
    }

    if (!args.yes) {
      log.info(
        `About to apply ${candidates.length} fix(es) to the working tree:`,
      );
      for (const f of candidates) {
        log.raw(`  ${pc.bold(f.id)} ${f.file}:${f.startLine}-${f.endLine}`);
      }
      const ok = await confirm('Proceed?', false);
      if (!ok) {
        log.info('Aborted.');
        return;
      }
    }

    // Apply bottom-up per file so earlier edits don't shift later line numbers.
    const byFile = new Map<string, ReviewFinding[]>();
    for (const f of candidates) {
      const arr = byFile.get(f.file) ?? [];
      arr.push(f);
      byFile.set(f.file, arr);
    }

    const results: ApplyResult[] = [];
    for (const [file, findings] of byFile) {
      const path = join(root, file);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        for (const f of findings)
          results.push({ id: f.id, file, ok: false, reason: 'file not found' });
        continue;
      }
      const ordered = [...findings].sort((a, b) => b.startLine - a.startLine);
      for (const f of ordered) {
        const next = applyPatchToContent(
          content,
          f.startLine,
          f.endLine,
          f.suggestedPatch ?? '',
        );
        if (next === undefined) {
          results.push({
            id: f.id,
            file,
            ok: false,
            reason: 'line range no longer matches (file changed since review?)',
          });
          continue;
        }
        content = next;
        results.push({ id: f.id, file, ok: true });
      }
      await writeFile(path, content, 'utf8');
    }

    const applied = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    for (const r of applied) log.success(`applied ${r.id} → ${r.file}`);
    for (const r of failed) log.warn(`skipped ${r.id} (${r.reason})`);
    log.info('');
    log.info(
      `${applied.length} applied, ${failed.length} skipped. Review with \`git diff\` before committing.`,
    );
    if (failed.length > 0 && applied.length === 0) process.exitCode = 1;
  },
});
