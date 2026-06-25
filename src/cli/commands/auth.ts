import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import {
  createApiKeyCredential,
  extractAccountIdFromJwt,
  loginWithBrowser,
  loginWithDeviceCode,
} from '@/auth/codex';
import {
  clearCredential,
  loadCredential,
  resolveCredentialFromEnv,
  saveCredential,
} from '@/auth/storage';
import type { CredentialRecord, Provider } from '@/inference/types';
import { log, pc } from '@/util/logger';
import { openBrowser } from '@/util/open';
import { authFilePath } from '@/util/paths';
import { promptLine } from '@/util/prompt';

function maskSecret(value: string | undefined): string {
  if (!value) return '(none)';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function describeCredential(cred: CredentialRecord): string {
  const parts = [`provider=${pc.bold(cred.provider)}`, `type=${cred.type}`];
  if (cred.type === 'oauth') {
    parts.push(`account=${cred.accountId ?? 'unknown'}`);
    if (cred.expiresAt) {
      const ms = Date.parse(cred.expiresAt) - Date.now();
      const mins = Math.round(ms / 60000);
      parts.push(
        ms > 0 ? `token expires in ~${mins}m` : pc.yellow('token expired'),
      );
    }
  } else {
    parts.push(`key=${maskSecret(cred.apiKey)}`);
  }
  if (cred.baseUrl) parts.push(`baseUrl=${cred.baseUrl}`);
  return parts.join('  ');
}

const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Connect a ChatGPT/Codex subscription or API key',
  },
  args: {
    device: {
      type: 'boolean',
      description: 'Use the device-code flow (for headless/remote machines)',
    },
    'api-key': {
      type: 'boolean',
      description: 'Authenticate with an API key instead of a subscription',
    },
    provider: {
      type: 'string',
      description:
        'Provider for --api-key (openai|anthropic|openai-compatible)',
    },
    'base-url': {
      type: 'string',
      description: 'Custom base URL for --api-key (e.g. Ollama/OpenRouter)',
    },
    key: {
      type: 'string',
      description: 'API key value (avoid; prefer the interactive prompt)',
    },
  },
  async run({ args }) {
    const authFile = authFilePath();

    if (args['api-key']) {
      const provider = (args.provider as Provider) || 'openai';
      if (
        !['openai', 'anthropic', 'openai-compatible', 'codex'].includes(
          provider,
        )
      ) {
        log.error(`Unknown provider '${provider}'.`);
        process.exitCode = 1;
        return;
      }
      let key = args.key as string | undefined;
      if (!key) {
        key = await promptLine(`Enter ${provider} API key: `, { mask: true });
      }
      if (!key) {
        log.error('No API key provided.');
        process.exitCode = 1;
        return;
      }
      const cred = createApiKeyCredential(
        key,
        provider,
        (args['base-url'] as string) || undefined,
      );
      await saveCredential(authFile, cred);
      log.success(
        `Saved ${provider} API-key credential to ${pc.dim(authFile)}`,
      );
      return;
    }

    if (args.device) {
      log.step('Requesting a device code from OpenAI…');
      const { verificationUrl, userCode, credential } =
        await loginWithDeviceCode();
      log.info('');
      log.info(`  Open: ${pc.cyan(verificationUrl)}`);
      log.info(`  Code: ${pc.bold(userCode)}`);
      log.info('');
      log.step('Waiting for you to authorize…');
      const cred = await credential;
      await saveCredential(authFile, cred);
      log.success('Connected your ChatGPT/Codex subscription.');
      return;
    }

    // Default: browser OAuth (PKCE) with a localhost callback.
    log.step('Starting browser login for your ChatGPT/Codex subscription…');
    const { url, credential } = await loginWithBrowser();
    log.info('');
    log.info(`  ${pc.dim('If your browser did not open, visit:')}`);
    log.info(`  ${pc.cyan(url)}`);
    log.info('');
    log.dim(
      '  (You can also paste the full callback URL here if the redirect fails.)',
    );
    openBrowser(url);
    const cred = await credential;
    await saveCredential(authFile, cred);
    log.success(
      'Connected your ChatGPT/Codex subscription. No API billing — your plan covers it.',
    );
  },
});

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the active credential' },
  async run() {
    const envCred = resolveCredentialFromEnv();
    if (envCred) {
      log.info(`${pc.bold('Active (from environment):')}`);
      log.info(`  ${describeCredential(envCred)}`);
    }
    const stored = await loadCredential(authFilePath());
    if (stored) {
      log.info(`${pc.bold('Stored credential:')}`);
      log.info(`  ${describeCredential(stored)}`);
    } else if (!envCred) {
      log.warn('No credential found. Run `ergo auth login` to get started.');
      process.exitCode = 1;
      return;
    }
  },
});

const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Remove the stored credential' },
  async run() {
    await clearCredential(authFilePath());
    log.success('Removed stored credential.');
  },
});

function jwtExpiry(jwt: string | undefined): string | undefined {
  if (!jwt) return undefined;
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const json = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as {
      exp?: number;
    };
    return json.exp ? new Date(json.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

// Convert a Codex-CLI-style auth.json into an ergo CredentialRecord.
function credentialFromCodexAuth(data: unknown): CredentialRecord | undefined {
  const obj = data as {
    tokens?: {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      account_id?: string;
    };
    OPENAI_API_KEY?: string | null;
  };
  const tokens = obj?.tokens;
  if (tokens?.access_token) {
    return {
      provider: 'codex',
      type: 'oauth',
      apiKey: obj.OPENAI_API_KEY ?? undefined,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId:
        tokens.account_id ??
        extractAccountIdFromJwt(tokens.id_token) ??
        extractAccountIdFromJwt(tokens.access_token),
      expiresAt: jwtExpiry(tokens.access_token) ?? jwtExpiry(tokens.id_token),
      createdAt: new Date().toISOString(),
    };
  }
  // ergo/juno-style { credential: {...} }
  const wrapped = (data as { credential?: CredentialRecord }).credential;
  if (wrapped?.accessToken || wrapped?.apiKey) return wrapped;
  return undefined;
}

const importCommand = defineCommand({
  meta: {
    name: 'import',
    description: 'Import an existing Codex CLI / ChatGPT credential',
  },
  args: {
    from: {
      type: 'string',
      description: 'Path to an auth.json (defaults to ~/.codex/auth.json)',
    },
  },
  async run({ args }) {
    const candidates = args.from
      ? [args.from as string]
      : [
          join(homedir(), '.codex', 'auth.json'),
          join(homedir(), '.juno', 'auth.json'),
        ];
    for (const path of candidates) {
      try {
        const data = JSON.parse(await readFile(path, 'utf8'));
        const cred = credentialFromCodexAuth(data);
        if (cred) {
          await saveCredential(authFilePath(), cred);
          log.success(
            `Imported ${cred.provider} ${cred.type} credential from ${pc.dim(path)}.`,
          );
          return;
        }
      } catch {
        // try next candidate
      }
    }
    log.error(
      'No importable credential found. Pass --from <path> to an auth.json, or run `ergo auth login`.',
    );
    process.exitCode = 1;
  },
});

export const authCommand = defineCommand({
  meta: { name: 'auth', description: 'Manage authentication' },
  subCommands: {
    login: loginCommand,
    import: importCommand,
    status: statusCommand,
    logout: logoutCommand,
  },
});
