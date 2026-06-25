#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';

import { authCommand } from '@/cli/commands/auth';
import { VERSION } from '@/version';

const main = defineCommand({
  meta: {
    name: 'ergo',
    version: VERSION,
    description:
      'Ergo — a fast, local-first AI code reviewer. Bring your own Codex/ChatGPT subscription or API key.',
  },
  subCommands: {
    auth: authCommand,
  },
});

runMain(main);
