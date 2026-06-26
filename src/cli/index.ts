#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';

import { withDefaultCommand } from '@/cli/args';
import { authCommand } from '@/cli/commands/auth';
import { chatCommand } from '@/cli/commands/chat';
import { configCommand } from '@/cli/commands/config';
import { describeCommand } from '@/cli/commands/describe';
import { doctorCommand } from '@/cli/commands/doctor';
import { fixCommand } from '@/cli/commands/fix';
import { hookCommand } from '@/cli/commands/hook';
import { learnCommand } from '@/cli/commands/learn';
import { mcpCommand } from '@/cli/commands/mcp';
import { modelsCommand } from '@/cli/commands/models';
import { findingsCommand, reviewCommand } from '@/cli/commands/review';
import { statsCommand } from '@/cli/commands/stats';
import { updateCommand } from '@/cli/commands/update';
import { usageCommand } from '@/cli/commands/usage';
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
    findings: findingsCommand,
    fix: fixCommand,
    describe: describeCommand,
    chat: chatCommand,
    auth: authCommand,
    config: configCommand,
    doctor: doctorCommand,
    learn: learnCommand,
    models: modelsCommand,
    stats: statsCommand,
    usage: usageCommand,
    update: updateCommand,
    mcp: mcpCommand,
    'install-hook': hookCommand,
  },
});

runMain(main, { rawArgs: withDefaultCommand(process.argv.slice(2)) });
