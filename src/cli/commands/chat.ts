import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';

import { defineCommand } from 'citty';

import { getActiveCredential } from '@/auth/resolve';
import { collectDiff, type ReviewTarget } from '@/git/diff';
import { isGitRepo, repoRoot } from '@/git/repo';
import { resolveClient } from '@/inference/resolve';
import type { ChatMessage } from '@/inference/types';
import { describeTarget } from '@/review/prompts';
import { serializeDiffSet } from '@/review/serialize';
import { log, pc } from '@/util/logger';

export const chatCommand = defineCommand({
  meta: {
    name: 'chat',
    description: 'Interactively ask questions about your changes',
  },
  args: {
    base: { type: 'string', description: 'Chat about a branch vs base' },
    commit: { type: 'string', alias: 'c', description: 'Chat about a commit' },
    dir: { type: 'string', description: 'Path to the git repo' },
    model: { type: 'string', alias: 'm', description: 'Override the model' },
  },
  async run({ args }) {
    const cwd = args.dir ? resolvePath(args.dir as string) : process.cwd();
    if (!(await isGitRepo(cwd))) {
      log.error('Not a git repository.');
      process.exitCode = 1;
      return;
    }
    const root = await repoRoot(cwd);

    const target: ReviewTarget = args.commit
      ? { kind: 'commit', ref: args.commit as string }
      : args.base
        ? { kind: 'branch', base: args.base as string }
        : { kind: 'working' };
    const diff = await collectDiff(target, { cwd: root });
    if (diff.files.length === 0) {
      log.error('No changes to chat about.');
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
      sessionId: `ergo-chat-${Date.now()}`,
    });

    const serialized = serializeDiffSet(diff, { maxChars: 150_000 }).text;
    const system = [
      'You are ergo, helping a developer understand and improve a code change.',
      'Answer questions about the following diff precisely and concisely. When asked for issues, be specific with file:line. When unsure, say so.',
      `## Changeset (${describeTarget(diff)})`,
      serialized,
    ].join('\n\n');

    const history: ChatMessage[] = [];

    log.info(pc.bold(`ergo chat — ${describeTarget(diff)}`));
    log.dim(
      `${diff.files.length} file(s), +${diff.totalAdditions}/-${diff.totalDeletions}. Type a question, or /exit, /clear, /files.`,
    );
    log.info('');

    const MAX_HISTORY = 24; // ~12 turns; the full diff is always in `system`
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Resolve a pending prompt with null on EOF (Ctrl+D / piped stdin) so the
    // loop exits cleanly instead of hanging on a promise that never settles.
    let pending: ((v: string | null) => void) | null = null;
    rl.on('close', () => {
      if (pending) {
        pending(null);
        pending = null;
      }
    });
    const ask = () =>
      new Promise<string | null>((resolve) => {
        pending = resolve;
        rl.question(pc.cyan('› '), (a) => {
          pending = null;
          resolve(a);
        });
      });

    // Ctrl+C cancels an in-flight response; pressing it at an idle prompt exits.
    let currentAbort: AbortController | null = null;
    rl.on('SIGINT', () => {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      } else {
        rl.close();
      }
    });

    try {
      while (true) {
        const raw = await ask();
        if (raw === null) break; // EOF
        const input = raw.trim();
        if (!input) continue;
        if (input === '/exit' || input === '/quit' || input === '/q') break;
        if (input === '/clear') {
          history.length = 0;
          log.dim('(history cleared)');
          continue;
        }
        if (input === '/files') {
          for (const f of diff.files) {
            log.raw(`  ${f.path} (+${f.additions}/-${f.deletions})`);
          }
          continue;
        }

        history.push({ role: 'user', content: input });
        process.stdout.write('\n');
        let answer = '';
        const controller = new AbortController();
        currentAbort = controller;
        try {
          const result = await resolved.client.complete({
            model: resolved.model,
            system,
            messages: history,
            temperature: 0.3,
            signal: controller.signal,
            onTextDelta: (d) => {
              answer += d;
              process.stdout.write(d);
            },
          });
          if (!answer) process.stdout.write(result.text);
          answer = answer || result.text;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (controller.signal.aborted) log.dim('\n(cancelled)');
          else log.error(msg);
          history.pop();
          continue;
        } finally {
          currentAbort = null;
        }
        history.push({ role: 'assistant', content: answer });
        // Trim oldest turns so a long session doesn't grow unbounded. Keep the
        // window starting on a user turn — Anthropic rejects a leading
        // assistant message.
        if (history.length > MAX_HISTORY) {
          history.splice(0, history.length - MAX_HISTORY);
          while (history.length > 0 && history[0]?.role !== 'user') {
            history.shift();
          }
        }
        process.stdout.write('\n\n');
      }
    } finally {
      rl.close();
    }
    log.dim('bye');
  },
});
