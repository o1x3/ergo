#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';

import { authCommand } from '@/cli/commands/auth';
import { reviewCommand } from '@/cli/commands/review';
import { VERSION } from '@/version';

const main = defineCommand({
  meta: {
    name: 'ergo',
    version: VERSION,
    description:
      'Ergo — a fast, local-first AI code reviewer. Bring your own Codex/ChatGPT subscription or API key.',
  },
  subCommands: {
    review: reviewCommand,
    auth: authCommand,
  },
});

// Known subcommands; anything else (e.g. `ergo --base main`) implies `review`.
const KNOWN = new Set(['review', 'auth']);
const HELP_VERSION = new Set(['--help', '-h', '--version', '-v']);

function withDefaultCommand(argv: string[]): string[] {
  const first = argv[0];
  if (!first || first.startsWith('-')) {
    if (first && HELP_VERSION.has(first)) return argv;
    return ['review', ...argv];
  }
  if (!KNOWN.has(first)) return ['review', ...argv];
  return argv;
}

runMain(main, { rawArgs: withDefaultCommand(process.argv.slice(2)) });
