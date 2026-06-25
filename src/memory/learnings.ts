import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
    id: createHash('sha256')
      .update(`${text}${file.learnings.length}`)
      .digest('hex')
      .slice(0, 8),
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

// Render the most relevant learnings as a prompt block (capped).
export async function loadLearningsForPrompt(
  repoRoot: string,
  scope: LearningScope = 'auto',
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const all = await listLearnings(repoRoot, scope, env);
  if (all.length === 0) return undefined;
  const recent = all.slice(-MAX_PROMPT_LEARNINGS);
  return recent.map((l) => `- ${l.text}`).join('\n');
}
