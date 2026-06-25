import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import { isGitRepo, repoRoot } from '@/git/repo';
import { log, pc } from '@/util/logger';

const MARKER = '# >>> ergo managed hook >>>';
const END_MARKER = '# <<< ergo managed hook <<<';

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

async function hookFile(root: string, type: string): Promise<string> {
  return join(root, '.git', 'hooks', type);
}

async function uninstall(root: string): Promise<number> {
  let removed = 0;
  for (const type of ['pre-push', 'pre-commit']) {
    const path = await hookFile(root, type);
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

    if (args.uninstall) {
      const removed = await uninstall(root);
      if (removed > 0)
        log.success(`Removed ergo hook(s) from ${removed} file(s).`);
      else log.info('No ergo hooks installed.');
      return;
    }

    const type =
      (args.type as string) === 'pre-commit' ? 'pre-commit' : 'pre-push';
    const failOn = (args['fail-on'] as string) ?? 'major';
    const path = await hookFile(root, type);
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });

    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      existing = '#!/usr/bin/env sh\n';
    }
    const cleaned = stripManaged(existing) || '#!/usr/bin/env sh';
    await writeFile(path, `${cleaned}\n\n${hookBody(type, failOn)}\n`, 'utf8');
    await chmod(path, 0o755);
    log.success(
      `Installed ${pc.bold(type)} hook (blocks on findings >= ${failOn}).`,
    );
    log.dim('Bypass any run with `git commit/push --no-verify`.');
  },
});
