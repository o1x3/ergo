import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  // Write to a 0600 temp file then atomically rename into place, so the
  // credential is never momentarily world-readable (no write-then-chmod window).
  const tmp = `${authFile}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(tmp, 0o600); // override umask
  await rename(tmp, authFile);
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
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'openai',
  'anthropic',
  'openai-compatible',
]);

export function resolveCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CredentialRecord | undefined {
  const now = new Date().toISOString();
  const generic = env.ERGO_API_KEY?.trim();
  if (generic) {
    const rawProvider = env.ERGO_PROVIDER?.trim();
    // A typo'd provider must fail loudly, not silently route the key to the
    // wrong backend (or crash later with `undefined` model lookups).
    if (rawProvider && !KNOWN_PROVIDERS.has(rawProvider)) {
      throw new Error(
        `Unknown ERGO_PROVIDER '${rawProvider}'. Use one of: ${[...KNOWN_PROVIDERS].join(', ')}.`,
      );
    }
    const provider = (rawProvider as Provider) || 'openai';
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
  if (credential?.type !== 'oauth') {
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
