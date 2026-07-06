import { defineCommand } from 'citty';
import { z } from 'zod';

import { getActiveCredential } from '@/auth/resolve';
import { loadConfig } from '@/config/load';
import { isGitRepo, recentLog, repoRoot } from '@/git/repo';
import { resolveClient } from '@/inference/resolve';
import { completeStructured } from '@/inference/structured';
import { addLearning, listLearnings, removeLearning } from '@/memory/learnings';
import { gatherGuidelines } from '@/review/context';
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

const mineSchema = z.object({
  learnings: z
    .array(z.string())
    .describe(
      'Durable, repo-specific review conventions (imperative, concise)',
    ),
});

const mineCommand = defineCommand({
  meta: {
    name: 'mine',
    description:
      "Learn this repo's review conventions from git history + guidelines",
  },
  args: {
    commits: {
      type: 'string',
      description: 'How many commits to mine (default 200)',
    },
    reviewers: {
      type: 'string',
      description: 'Comma-separated authors to mirror (git --author filters)',
    },
    global: { type: 'boolean', description: 'Store globally (all repos)' },
    model: { type: 'string', alias: 'm', description: 'Override the model' },
  },
  async run({ args }) {
    if (!(await isGitRepo())) {
      log.error('Not a git repository.');
      process.exitCode = 1;
      return;
    }
    const repoRootDir = await repoRoot();
    const { config } = await loadConfig(repoRootDir);

    let credential: Awaited<ReturnType<typeof getActiveCredential>>;
    try {
      credential = await getActiveCredential();
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const resolved = resolveClient({
      credential,
      modelOverride: args.model as string | undefined,
    });

    const authors = (args.reviewers as string | undefined)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = args.commits ? Number(args.commits) : 200;
    if (!Number.isInteger(limit) || limit <= 0) {
      log.error(`Invalid --commits '${args.commits}'. Use a positive integer.`);
      process.exitCode = 1;
      return;
    }
    log.step('Mining commit history and guidelines…');
    const [history, guidelines] = await Promise.all([
      recentLog({ limit, authors, cwd: repoRootDir }),
      gatherGuidelines(repoRootDir, config),
    ]);
    if (!history && !guidelines) {
      log.error('No commit history or guidelines found to learn from.');
      process.exitCode = 1;
      return;
    }

    const result = await completeStructured({
      client: resolved.client,
      model: resolved.model,
      schema: mineSchema,
      jsonSchema: z.toJSONSchema(mineSchema) as Record<string, unknown>,
      system:
        'You extract durable, repo-specific CODE-REVIEW conventions a reviewer should consistently apply. Output concise, imperative rules (e.g. "Require parameterized SQL"). Ignore one-off changes; capture only patterns worth enforcing on every review. Max 15.',
      messages: [
        {
          role: 'user',
          content: [
            guidelines ? `## Guidelines\n${guidelines}` : '',
            history
              ? `## Recent commit history\n${history.slice(0, 60_000)}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      temperature: 0.2,
    });

    const scope = args.global ? 'global' : 'local';
    let saved = 0;
    for (const text of result.value.learnings.slice(0, 15)) {
      if (text.trim()) {
        await addLearning(repoRootDir, text, { scope, source: 'history' });
        saved += 1;
      }
    }
    log.success(
      `Learned ${saved} convention(s) from history. View with \`ergo learn list\`.`,
    );
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
    mine: mineCommand,
  },
});
