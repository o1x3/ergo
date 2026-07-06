import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { defineCommand } from 'citty';

import { git, isGitRepo, repoRoot } from '@/git/repo';
import { SEVERITIES, type Severity } from '@/review/schema';
import { log, pc } from '@/util/logger';

const MARKER = '# >>> ergo managed hook >>>';
const END_MARKER = '# <<< ergo managed hook <<<';
const HOOK_TYPES = ['pre-push', 'pre-commit'] as const;

function hookBody(type: string, failOn: string): string {
  // Keep it simple and robust: pre-commit reviews staged changes; pre-push
  // reviews the working tree. Non-zero exit blocks the operation.
  const cmd =
    type === 'pre-commit'
      ? `ergo review --type staged --light --fail-on ${failOn} --quiet`
      : `ergo review --light --fail-on ${failOn} --quiet`;
  return [
    MARKER,
    '# Installed by `ergo install-hook`. Remove with `ergo install-hook --uninstall`.',
    'if command -v ergo >/dev/null 2>&1; then',
    `  ${cmd} || { echo "ergo: blocking ${type} on findings >= ${failOn}. Use --no-verify to bypass." >&2; exit 1; }`,
    'fi',
    END_MARKER,
  ].join('\n');
}

function stripManaged(content: string): string {
  const start = content.indexOf(MARKER);
  if (start === -1) return content;
  const end = content.indexOf(END_MARKER);
  if (end === -1) return content.slice(0, start).trimEnd();
  return (
    content.slice(0, start) + content.slice(end + END_MARKER.length)
  ).trim();
}

// Resolve the real hooks directory, honoring worktrees and core.hooksPath
// (manually building <root>/.git/hooks breaks in both cases).
async function hooksDir(root: string): Promise<string> {
  try {
    const out = (await git(['rev-parse', '--git-path', 'hooks'], root)).trim();
    return isAbsolute(out) ? out : join(root, out);
  } catch {
    return join(root, '.git', 'hooks');
  }
}

async function uninstall(dir: string): Promise<number> {
  let removed = 0;
  for (const type of HOOK_TYPES) {
    const path = join(dir, type);
    try {
      const content = await readFile(path, 'utf8');
      if (!content.includes(MARKER)) continue;
      const cleaned = stripManaged(content).trim();
      if (cleaned && cleaned !== '#!/usr/bin/env sh') {
        await writeFile(path, `${cleaned}\n`, 'utf8');
      } else {
        await rm(path, { force: true });
      }
      removed += 1;
    } catch {
      // no such hook
    }
  }
  return removed;
}

export const hookCommand = defineCommand({
  meta: {
    name: 'install-hook',
    description: 'Install a git hook that runs ergo before commit/push',
  },
  args: {
    type: { type: 'string', description: 'pre-push (default) or pre-commit' },
    'fail-on': {
      type: 'string',
      description: 'Severity that blocks (default: major)',
    },
    uninstall: { type: 'boolean', description: 'Remove ergo git hooks' },
  },
  async run({ args }) {
    if (!(await isGitRepo())) {
      log.error('Not a git repository.');
      process.exitCode = 1;
      return;
    }
    const root = await repoRoot();
    const dir = await hooksDir(root);

    if (args.uninstall) {
      const removed = await uninstall(dir);
      if (removed > 0)
        log.success(`Removed ergo hook(s) from ${removed} file(s).`);
      else log.info('No ergo hooks installed.');
      return;
    }

    // Validate inputs — never interpolate unvalidated values into the shell hook.
    const typeArg = (args.type as string | undefined) ?? 'pre-push';
    if (!HOOK_TYPES.includes(typeArg as (typeof HOOK_TYPES)[number])) {
      log.error(`Invalid --type '${typeArg}'. Use pre-push or pre-commit.`);
      process.exitCode = 1;
      return;
    }
    const failOn = (
      (args['fail-on'] as string | undefined) ?? 'major'
    ).toLowerCase();
    if (!SEVERITIES.includes(failOn as Severity)) {
      log.error(
        `Invalid --fail-on '${failOn}'. Use one of: ${SEVERITIES.join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }

    const path = join(dir, typeArg);
    await mkdir(dir, { recursive: true });
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      existing = '#!/usr/bin/env sh\n';
    }
    const cleaned = stripManaged(existing) || '#!/usr/bin/env sh';
    await writeFile(
      path,
      `${cleaned}\n\n${hookBody(typeArg, failOn)}\n`,
      'utf8',
    );
    await chmod(path, 0o755);
    log.success(
      `Installed ${pc.bold(typeArg)} hook (blocks on findings >= ${failOn}).`,
    );
    log.dim('Bypass any run with `git commit/push --no-verify`.');
  },
});
