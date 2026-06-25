import { defineCommand } from 'citty';
import { loadCredential, resolveCredentialFromEnv } from '@/auth/storage';
import {
  CHATGPT_ACCOUNT_SAFE_MODELS,
  DEFAULT_MODELS,
  FAST_MODELS,
  PRICING,
} from '@/inference/models';
import { log, pc } from '@/util/logger';
import { authFilePath } from '@/util/paths';

export const modelsCommand = defineCommand({
  meta: {
    name: 'models',
    description: 'List available models and pricing',
  },
  async run() {
    const cred =
      resolveCredentialFromEnv() ?? (await loadCredential(authFilePath()));
    const provider = cred?.provider;

    if (provider) {
      log.info(`Active provider: ${pc.bold(provider)}`);
      log.info(
        `  default=${pc.cyan(DEFAULT_MODELS[provider])}  fast=${pc.cyan(FAST_MODELS[provider])}`,
      );
      log.info('');
    }

    if (!provider || provider === 'codex') {
      log.info(pc.bold('ChatGPT/Codex subscription models:'));
      for (const m of CHATGPT_ACCOUNT_SAFE_MODELS) {
        log.raw(`  ${m}`);
      }
      log.info('');
    }

    log.info(pc.bold('Pricing (USD / 1M tokens, in → out):'));
    for (const [model, price] of Object.entries(PRICING)) {
      log.raw(
        `  ${model.padEnd(28)} ${pc.dim(`$${price.input} → $${price.output}`)}`,
      );
    }
    log.info('');
    log.dim(
      'On a ChatGPT/Codex subscription, reviews are covered by your plan ($0 API).',
    );
  },
});
