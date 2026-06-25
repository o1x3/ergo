import { resolve as resolvePath } from 'node:path';

import { defineCommand } from 'citty';
import { z } from 'zod';

import { getActiveCredential } from '@/auth/resolve';
import { collectDiff, type ReviewTarget } from '@/git/diff';
import { isGitRepo, repoRoot } from '@/git/repo';
import { resolveClient } from '@/inference/resolve';
import { completeStructured } from '@/inference/structured';
import { serializeDiffSet } from '@/review/serialize';
import { log } from '@/util/logger';

const describeSchema = z.object({
  title: z.string().describe('A concise, conventional PR/commit title'),
  description: z
    .string()
    .describe('A clear markdown PR description: what changed, why, and how'),
});

export const describeCommand = defineCommand({
  meta: {
    name: 'describe',
    description: 'Generate a PR/commit title and description from the diff',
  },
  args: {
    base: { type: 'string', description: 'Base branch (default: auto-detect)' },
    dir: { type: 'string', description: 'Path to the git repo' },
    model: { type: 'string', alias: 'm', description: 'Override the model' },
    title: { type: 'boolean', description: 'Print only the title' },
  },
  async run({ args }) {
    const cwd = args.dir ? resolvePath(args.dir as string) : process.cwd();
    if (!(await isGitRepo(cwd))) {
      log.error('Not a git repository.');
      process.exitCode = 1;
      return;
    }
    const root = await repoRoot(cwd);

    const explicitBase = Boolean(args.base);
    const target: ReviewTarget = explicitBase
      ? { kind: 'branch', base: args.base as string }
      : { kind: 'branch', base: 'auto' };
    let diff = await collectDiff(target, { cwd: root });
    if (diff.files.length === 0 && !explicitBase) {
      // Only fall back to working-tree changes when the base was auto-detected
      // (the branch may have no commits yet). An explicit --base with no diff is
      // reported as-is rather than silently describing something else.
      diff = await collectDiff({ kind: 'working' }, { cwd: root });
    }
    if (diff.files.length === 0) {
      log.error(
        explicitBase
          ? `No changes against ${args.base}.`
          : 'No changes to describe.',
      );
      process.exitCode = 1;
      return;
    }

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

    log.step('Generating description…');
    const text = serializeDiffSet(diff, { maxChars: 120_000 }).text;
    const result = await completeStructured({
      client: resolved.client,
      model: resolved.model,
      schema: describeSchema,
      jsonSchema: z.toJSONSchema(describeSchema) as Record<string, unknown>,
      system:
        'You write excellent, concise pull-request descriptions. Use Conventional Commits style for the title. The description should be markdown with a short summary and bullet points of notable changes.',
      messages: [
        {
          role: 'user',
          content: `Describe this changeset.\n\n## Diff\n${text}`,
        },
      ],
      temperature: 0.3,
    });

    if (args.title) {
      process.stdout.write(`${result.value.title}\n`);
      return;
    }
    process.stdout.write(
      `# ${result.value.title}\n\n${result.value.description}\n`,
    );
  },
});
