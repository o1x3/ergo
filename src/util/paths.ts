import { homedir } from 'node:os';
import { join } from 'node:path';

// Resolve ergo's home directory. Honors ERGO_HOME, then XDG-ish defaults,
// finally ~/.ergo. Everything ergo persists (credentials, caches, learnings)
// lives under here so it is trivial to inspect and wipe.
export function ergoHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ERGO_HOME?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), '.ergo');
}

export function authFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ergoHome(env), 'auth.json');
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ergoHome(env), 'cache');
}

export function learningsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ergoHome(env), 'learnings.json');
}

// Per-repo state (last-reviewed commit, incremental markers) keyed by an
// absolute repo path. Stored centrally so a clean checkout stays clean.
export function repoStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ergoHome(env), 'repos');
}
