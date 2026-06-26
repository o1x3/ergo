import { extractAccountIdFromJwt } from '@/auth/codex';
import { createAiSdkClient } from '@/inference/aisdk-client';
import { createCodexClient } from '@/inference/codex-client';
import {
  DEFAULT_MODELS,
  FAST_MODELS,
  isChatGptAccountSafeModel,
} from '@/inference/models';
import type {
  CredentialRecord,
  ModelClient,
  Provider,
} from '@/inference/types';
import { saveRateLimits } from '@/memory/ratelimits';

export type ResolvedClient = {
  client: ModelClient;
  model: string;
  provider: Provider;
  subscription: boolean;
  fallbackFrom?: string;
};

export type ResolveOptions = {
  credential: CredentialRecord;
  modelOverride?: string;
  fast?: boolean;
  sessionId?: string;
};

// Build the right ModelClient for a credential and pick the effective model.
// Codex OAuth → ChatGPT-subscription responses backend; everything else →
// ai-sdk provider. Model resolution: explicit override wins, then config/default,
// with a safety remap for the Codex backend's restricted allowlist.
export function resolveClient(opts: ResolveOptions): ResolvedClient {
  const { credential } = opts;

  if (credential.provider === 'codex' && credential.type === 'oauth') {
    if (!credential.accessToken) {
      throw new Error(
        'Codex credential is missing an access token. Re-run `ergo auth login`.',
      );
    }
    const accountId =
      credential.accountId ??
      extractAccountIdFromJwt(credential.accessToken) ??
      '';
    const client = createCodexClient({
      baseUrl:
        credential.baseUrl ||
        process.env.ERGO_CODEX_BASE_URL ||
        'https://chatgpt.com/backend-api/codex/responses',
      accessToken: credential.accessToken,
      accountId,
      sessionId: opts.sessionId,
      // Persist the rate-limit snapshot from every Codex response so `ergo
      // usage` can report remaining quota. Fire-and-forget; never blocks.
      onRateLimits: (snapshot) => {
        void saveRateLimits(snapshot);
      },
    });

    const desired =
      opts.modelOverride ??
      (opts.fast ? FAST_MODELS.codex : DEFAULT_MODELS.codex);
    if (isChatGptAccountSafeModel(desired)) {
      return {
        client,
        model: desired,
        provider: 'codex',
        subscription: true,
      };
    }
    const safe = opts.fast ? FAST_MODELS.codex : DEFAULT_MODELS.codex;
    return {
      client,
      model: safe,
      provider: 'codex',
      subscription: true,
      fallbackFrom: opts.modelOverride,
    };
  }

  // API-key path. A `codex` api-key credential routes through the OpenAI
  // provider (the key is a standard OpenAI key, not a subscription).
  const provider: Exclude<Provider, 'codex'> =
    credential.provider === 'codex' ? 'openai' : credential.provider;
  if (!credential.apiKey) {
    throw new Error(
      `Credential for ${credential.provider} is missing an API key. Run \`ergo auth login\` or set the provider env var.`,
    );
  }
  const client = createAiSdkClient({
    provider,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
  });
  const model =
    opts.modelOverride ??
    (opts.fast ? FAST_MODELS[provider] : DEFAULT_MODELS[provider]);
  return { client, model, provider, subscription: false };
}
