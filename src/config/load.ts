import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  type ErgoConfig,
  ergoConfigSchema,
  type ResolvedConfig,
  resolveConfig,
} from '@/config/schema';
import { ergoHome } from '@/util/paths';

const REPO_CONFIG_NAMES = ['.ergo.yaml', '.ergo.yml'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Deep-merge `override` onto `base` (objects merge, everything else replaces).
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override as T) ?? base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    out[k] =
      isPlainObject(existing) && isPlainObject(v) ? deepMerge(existing, v) : v;
  }
  return out as T;
}

async function readYamlIfExists(
  path: string,
): Promise<{ data: unknown; path: string } | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return { data: parseYaml(raw) ?? {}, path };
  } catch {
    return undefined;
  }
}

export type LoadConfigResult = {
  config: ResolvedConfig;
  sources: string[];
  errors: string[];
};

function globalConfigCandidates(env: NodeJS.ProcessEnv): string[] {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const candidates: string[] = [];
  if (xdg) candidates.push(join(xdg, 'ergo', 'config.yaml'));
  candidates.push(join(homedir(), '.config', 'ergo', 'config.yaml'));
  candidates.push(join(ergoHome(env), 'config.yaml'));
  return candidates;
}

// Load and merge config: built-in defaults < global < repo. The repo config wins
// for any key it sets; `inheritance: false` (the default for a repo config that
// sets it) still merges since we always layer global first then repo on top.
export async function loadConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadConfigResult> {
  const sources: string[] = [];
  const errors: string[] = [];
  let merged: ErgoConfig = {};

  // Global first (lowest precedence).
  for (const candidate of globalConfigCandidates(env)) {
    const found = await readYamlIfExists(candidate);
    if (found) {
      const parsed = ergoConfigSchema.safeParse(found.data);
      if (parsed.success) {
        merged = deepMerge(merged, parsed.data);
        sources.push(found.path);
      } else {
        errors.push(`${found.path}: ${parsed.error.issues[0]?.message}`);
      }
      break;
    }
  }

  // Repo config (highest precedence).
  for (const name of REPO_CONFIG_NAMES) {
    const found = await readYamlIfExists(join(repoRoot, name));
    if (found) {
      const parsed = ergoConfigSchema.safeParse(found.data);
      if (parsed.success) {
        merged = deepMerge(merged, parsed.data);
        sources.push(found.path);
      } else {
        errors.push(`${found.path}: ${parsed.error.issues[0]?.message}`);
      }
      break;
    }
  }

  return { config: resolveConfig(merged), sources, errors };
}

export function parseConfigString(text: string): {
  ok: boolean;
  config?: ResolvedConfig;
  error?: string;
} {
  let data: unknown;
  try {
    data = parseYaml(text) ?? {};
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const parsed = ergoConfigSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message };
  }
  return { ok: true, config: resolveConfig(parsed.data) };
}
