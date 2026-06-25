import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { refreshOAuthCredential } from '@/auth/codex';
import type { CredentialRecord, Provider } from '@/inference/types';

export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

// On-disk auth file. A single active credential keeps the model simple; the
// active provider is whatever was last logged in. `version` lets us migrate the
// shape later without silently misreading old files.
type AuthFile = {
  version: 1;
  credential: CredentialRecord;
};

export async function saveCredential(
  authFile: string,
  credential: CredentialRecord,
): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true });
  const payload: AuthFile = { version: 1, credential };
  await Bun.write(authFile, `${JSON.stringify(payload, null, 2)}\n`);
  await chmod(authFile, 0o600);
}

export async function loadCredential(
  authFile: string,
): Promise<CredentialRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(authFile, 'utf8')) as Partial<
      AuthFile & { provider: Provider }
    >;
    return raw.credential;
  } catch {
    return undefined;
  }
}

export async function clearCredential(authFile: string): Promise<void> {
  await rm(authFile, { force: true });
}

// Environment variables short-circuit stored credentials so CI can run ergo
// without an interactive login. Precedence: ERGO_API_KEY (provider-agnostic) >
// provider-specific keys > stored credential.
export function resolveCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CredentialRecord | undefined {
  const now = new Date().toISOString();
  const generic = env.ERGO_API_KEY?.trim();
  if (generic) {
    const provider = (env.ERGO_PROVIDER?.trim() as Provider) || 'openai';
    return {
      provider,
      type: 'api-key',
      apiKey: generic,
      baseUrl: env.ERGO_BASE_URL?.trim() || undefined,
      createdAt: now,
    };
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return {
      provider: 'anthropic',
      type: 'api-key',
      apiKey: env.ANTHROPIC_API_KEY.trim(),
      createdAt: now,
    };
  }
  if (env.OPENAI_API_KEY?.trim()) {
    return {
      provider: 'openai',
      type: 'api-key',
      apiKey: env.OPENAI_API_KEY.trim(),
      baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      createdAt: now,
    };
  }
  return undefined;
}

export type RefreshOptions = {
  nowMs?: number;
  skewMs?: number;
  refresher?: typeof refreshOAuthCredential;
  persist?: typeof saveCredential;
};

export async function refreshCredentialIfNearExpiry(
  authFile: string,
  credential: CredentialRecord | undefined,
  options: RefreshOptions = {},
): Promise<CredentialRecord | undefined> {
  if (!credential || credential.type !== 'oauth') {
    return credential;
  }
  if (!credential.expiresAt || !credential.refreshToken) {
    return credential;
  }

  const now = options.nowMs ?? Date.now();
  const skew = options.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const expiresAtMs = Date.parse(credential.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs - now > skew) {
    return credential;
  }

  const refresh = options.refresher ?? refreshOAuthCredential;
  const persist = options.persist ?? saveCredential;
  const refreshed = await refresh(
    credential as CredentialRecord & { type: 'oauth' },
  );
  await persist(authFile, refreshed);
  return refreshed;
}
