import {
  loadCredential,
  refreshCredentialIfNearExpiry,
  resolveCredentialFromEnv,
} from '@/auth/storage';
import type { CredentialRecord } from '@/inference/types';
import { authFilePath } from '@/util/paths';

export class AuthError extends Error {}

// Resolve the active credential for inference. Precedence: environment variables
// (CI-friendly) > stored credential (refreshing OAuth tokens near expiry).
// Throws AuthError with a clear next step when nothing is configured.
export async function getActiveCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialRecord> {
  const fromEnv = resolveCredentialFromEnv(env);
  if (fromEnv) return fromEnv;

  const authFile = authFilePath(env);
  const stored = await loadCredential(authFile);
  if (!stored) {
    throw new AuthError(
      'Not authenticated. Run `ergo auth login` to connect your ChatGPT/Codex subscription, or `ergo auth login --api-key` to use an API key.',
    );
  }

  try {
    const refreshed = await refreshCredentialIfNearExpiry(authFile, stored);
    return refreshed ?? stored;
  } catch (err) {
    throw new AuthError(
      `Failed to refresh credential: ${err instanceof Error ? err.message : String(err)}. Re-run \`ergo auth login\`.`,
    );
  }
}
