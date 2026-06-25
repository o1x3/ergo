import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ergoHome } from '@/util/paths';

export type LearningScope = 'local' | 'global' | 'auto';

export interface Learning {
  id: string;
  text: string;
  createdAt: string;
  source: 'manual' | 'rejection' | 'history';
  tags?: string[];
}

interface LearningsFile {
  version: 1;
  learnings: Learning[];
}

const MAX_PROMPT_LEARNINGS = 40;

function repoKey(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
}

function localPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(ergoHome(env), 'learnings', `${repoKey(repoRoot)}.json`);
}

function globalPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ergoHome(env), 'learnings', 'global.json');
}

async function readFileSafe(path: string): Promise<LearningsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as LearningsFile;
    if (Array.isArray(parsed.learnings)) return parsed;
  } catch {
    // missing/corrupt — start fresh
  }
  return { version: 1, learnings: [] };
}

async function writeFileSafe(path: string, data: LearningsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: a crash mid-write (or a concurrent process) can never leave a
  // truncated/empty learnings file.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function listLearnings(
  repoRoot: string,
  scope: LearningScope = 'auto',
  env: NodeJS.ProcessEnv = process.env,
): Promise<Learning[]> {
  const out: Learning[] = [];
  if (scope === 'local' || scope === 'auto') {
    out.push(...(await readFileSafe(localPath(repoRoot, env))).learnings);
  }
  if (scope === 'global' || scope === 'auto') {
    out.push(...(await readFileSafe(globalPath(env))).learnings);
  }
  return out;
}

export async function addLearning(
  repoRoot: string,
  text: string,
  opts: {
    scope?: 'local' | 'global';
    source?: Learning['source'];
    tags?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Learning> {
  const env = opts.env ?? process.env;
  const scope = opts.scope ?? 'local';
  const path = scope === 'global' ? globalPath(env) : localPath(repoRoot, env);
  const file = await readFileSafe(path);
  const learning: Learning = {
    // Collision-free id (the old length-based hash collided across files/edits,
    // so `learn rm` could delete several entries at once).
    id: randomUUID().slice(0, 8),
    text: text.trim(),
    createdAt: new Date().toISOString(),
    source: opts.source ?? 'manual',
    tags: opts.tags,
  };
  file.learnings.push(learning);
  await writeFileSafe(path, file);
  return learning;
}

export async function removeLearning(
  repoRoot: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const path of [localPath(repoRoot, env), globalPath(env)]) {
    const file = await readFileSafe(path);
    const next = file.learnings.filter((l) => l.id !== id);
    if (next.length !== file.learnings.length) {
      await writeFileSafe(path, { version: 1, learnings: next });
      return true;
    }
  }
  return false;
}

// Render the most relevant learnings as a prompt block (capped). Under `auto`,
// reserve a quota per scope so a large global list can't starve repo-local
// learnings (which are usually the most relevant).
export async function loadLearningsForPrompt(
  repoRoot: string,
  scope: LearningScope = 'auto',
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let selected: Learning[];
  if (scope === 'auto') {
    const local = await listLearnings(repoRoot, 'local', env);
    const global = await listLearnings(repoRoot, 'global', env);
    const half = Math.floor(MAX_PROMPT_LEARNINGS / 2);
    const localPick = local.slice(
      -Math.max(half, MAX_PROMPT_LEARNINGS - global.length),
    );
    const globalPick = global.slice(-(MAX_PROMPT_LEARNINGS - localPick.length));
    selected = [...localPick, ...globalPick];
  } else {
    selected = (await listLearnings(repoRoot, scope, env)).slice(
      -MAX_PROMPT_LEARNINGS,
    );
  }
  if (selected.length === 0) return undefined;
  return selected.map((l) => `- ${l.text}`).join('\n');
}
