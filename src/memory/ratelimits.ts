import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RateLimitSnapshot } from '@/inference/ratelimits';
import { rateLimitsPath } from '@/util/paths';

// Persist the latest Codex rate-limit snapshot (single file, overwritten each
// time) so `ergo usage` can show remaining quota without an extra API call.
// Best-effort: never throws — usage telemetry must not break a review.
export async function saveRateLimits(
  snapshot: RateLimitSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const path = rateLimitsPath(env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(snapshot)}\n`, 'utf8');
  } catch {
    // ignore
  }
}

export async function readRateLimits(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitSnapshot | undefined> {
  try {
    const raw = await readFile(rateLimitsPath(env), 'utf8');
    const parsed = JSON.parse(raw) as RateLimitSnapshot;
    if (parsed && typeof parsed.capturedAt === 'number') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}
