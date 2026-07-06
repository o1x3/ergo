import type { Provider } from '@/inference/types';

// Models the ChatGPT-account Codex backend accepts. Older/codex-mini slugs are
// excluded — the backend returns 400 "not supported when using Codex with a
// ChatGPT account" for them. Refresh deliberately when upstream ships new ones.
export const CHATGPT_ACCOUNT_SAFE_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.1-codex',
  'gpt-5.1',
]);

export function isChatGptAccountSafeModel(id: string): boolean {
  return CHATGPT_ACCOUNT_SAFE_MODELS.has(id);
}

// Sensible default review models per provider. Reviews favor strong reasoning
// at moderate cost; users override via config or --model.
export const DEFAULT_MODELS: Record<Provider, string> = {
  codex: 'gpt-5.4',
  openai: 'gpt-5.4',
  anthropic: 'claude-opus-4-8',
  'openai-compatible': 'gpt-5.4',
};

// A cheaper model for high-volume / quick passes (summaries, triage).
export const FAST_MODELS: Record<Provider, string> = {
  codex: 'gpt-5.4-mini',
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5',
  'openai-compatible': 'gpt-5.4-mini',
};

// USD per 1M tokens, for the cost report ergo prints after a review. Static
// snapshot; kept conservative. `cacheRead` is the discounted cached-input rate.
export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export const PRICING: Record<string, ModelPricing> = {
  'gpt-5.5': { input: 2.5, output: 15, cacheRead: 0.25 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1 },
};

export function lookupPricing(model: string): ModelPricing | undefined {
  if (PRICING[model]) return PRICING[model];
  // Loose match: strip date suffixes / -latest.
  const base = model.replace(/-\d{8}$/, '').replace(/-latest$/, '');
  return PRICING[base];
}

export function estimateCostUsd(
  model: string,
  usage:
    | { input: number; output: number; cacheRead?: number; cacheWrite?: number }
    | undefined,
  opts: { provider?: Provider } = {},
): number | undefined {
  if (!usage) return undefined;
  const price = lookupPricing(model);
  if (!price) return undefined;
  const cached = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  // Provider token-accounting semantics differ:
  //  - OpenAI/Codex: `input` already INCLUDES cached tokens, so subtract them.
  //  - Anthropic: `input` EXCLUDES cache-read/cache-write tokens (they are
  //    separate counters), so the fresh-input charge is `input` as-is.
  const anthropicStyle = opts.provider === 'anthropic';
  const freshInput = anthropicStyle
    ? usage.input
    : Math.max(0, usage.input - cached);
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input * 1.25;
  return (
    (freshInput * price.input) / 1_000_000 +
    (cached * cacheReadRate) / 1_000_000 +
    (cacheWrite * cacheWriteRate) / 1_000_000 +
    (usage.output * price.output) / 1_000_000
  );
}

// For codex (ChatGPT subscription) usage is covered by the user's plan, so the
// "cost" we report is $0 of incremental API spend — a core selling point.
export function isSubscriptionCovered(
  provider: Provider,
  type: string,
): boolean {
  return provider === 'codex' && type === 'oauth';
}
