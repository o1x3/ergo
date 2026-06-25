import { defineCommand } from 'citty';

import { isGitRepo, repoRoot } from '@/git/repo';
import { addLearning, listLearnings, removeLearning } from '@/memory/learnings';
import { log, pc } from '@/util/logger';

async function root(): Promise<string> {
  return (await isGitRepo()) ? await repoRoot() : process.cwd();
}

const addCommand = defineCommand({
  meta: { name: 'add', description: 'Teach ergo a durable preference/fact' },
  args: {
    text: { type: 'positional', required: true, description: 'The learning' },
    global: { type: 'boolean', description: 'Store globally (all repos)' },
  },
  async run({ args }) {
    const learning = await addLearning(await root(), String(args.text), {
      scope: args.global ? 'global' : 'local',
    });
    log.success(`Learned (${learning.id}): ${learning.text}`);
  },
});

const listCommand = defineCommand({
  meta: { name: 'list', description: 'List learnings' },
  args: {
    scope: { type: 'string', description: 'local | global | auto (default)' },
  },
  async run({ args }) {
    const scopeArg = (args.scope as string | undefined) ?? 'auto';
    if (!['local', 'global', 'auto'].includes(scopeArg)) {
      log.error(`Invalid --scope '${scopeArg}'. Use local | global | auto.`);
      process.exitCode = 1;
      return;
    }
    const scope = scopeArg as 'local' | 'global' | 'auto';
    const learnings = await listLearnings(await root(), scope);
    if (learnings.length === 0) {
      log.info('No learnings yet. Add one with `ergo learn add "<fact>"`.');
      return;
    }
    for (const l of learnings) {
      log.raw(`${pc.dim(l.id)} ${pc.dim(`[${l.source}]`)} ${l.text}`);
    }
  },
});

const rmCommand = defineCommand({
  meta: { name: 'rm', description: 'Remove a learning by id' },
  args: {
    id: { type: 'positional', required: true, description: 'Learning id' },
  },
  async run({ args }) {
    const ok = await removeLearning(await root(), String(args.id));
    if (ok) log.success(`Removed ${args.id}.`);
    else {
      log.error(`No learning with id ${args.id}.`);
      process.exitCode = 1;
    }
  },
});

export const learnCommand = defineCommand({
  meta: {
    name: 'learn',
    description: 'Manage review learnings (ergo remembers your preferences)',
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
    rm: rmCommand,
  },
});
