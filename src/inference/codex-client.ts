import { arch, platform, release } from 'node:os';

import { extractAccountIdFromJwt } from '@/auth/codex';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelClient,
  ModelUsage,
  ReasoningEffort,
} from '@/inference/types';

function estimateUsage(input: string, output: string): ModelUsage {
  return {
    input: Math.ceil(input.length / 4),
    output: Math.ceil(output.length / 4),
    estimated: true,
  };
}

export type CodexRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
};

export type CodexClientConfig = {
  baseUrl: string;
  accessToken: string;
  accountId: string;
  sessionId?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  retry?: CodexRetryOptions;
};

const DEFAULT_RETRY: Required<CodexRetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitterRatio: 0.25,
};

export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function fetchCodexWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: {
    sleep?: (ms: number) => Promise<void>;
    retry?: CodexRetryOptions;
    random?: () => number;
  } = {},
): Promise<Response> {
  const cfg = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let response: Response | undefined;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    response = await fetchImpl(url, init);
    if (response.ok) return response;
    if (!isRetryableStatus(response.status) || attempt === cfg.maxAttempts) {
      return response;
    }
    const headerWait = parseRetryAfter(response.headers.get('retry-after'));
    const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
    // Cap the server-provided Retry-After too, so a hostile/huge header can't
    // stall us indefinitely.
    const wait =
      headerWait !== null ? Math.min(cfg.maxDelayMs, headerWait) : exp;
    const jitter = random() * wait * cfg.jitterRatio;
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore
      }
    }
    await sleep(wait + jitter);
  }
  return response as Response;
}

type CodexInputItem = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
};

type CodexRequestBody = {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  stream: true;
  include: string[];
  parallel_tool_calls: boolean;
  tool_choice: 'auto';
  prompt_cache_key?: string;
  reasoning?: { effort: ReasoningEffort };
  text?: { format: { type: 'json_object' } };
};

export function buildCodexInput(messages: ChatMessage[]): CodexInputItem[] {
  const input: CodexInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      // System content is folded into `instructions`; skip here.
      continue;
    }
    input.push({
      type: 'message',
      role: message.role,
      content: [
        {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        },
      ],
    });
  }
  return input;
}

export function buildCodexHeaders(config: {
  accessToken: string;
  accountId: string;
  sessionId?: string;
}): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${config.accessToken}`);
  headers.set('chatgpt-account-id', config.accountId);
  headers.set('OpenAI-Beta', 'responses=experimental');
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  headers.set('originator', 'ergo');
  headers.set('User-Agent', `ergo (${platform()} ${release()}; ${arch()})`);
  if (config.sessionId) {
    headers.set('session_id', config.sessionId);
    headers.set('x-client-request-id', config.sessionId);
  }
  return headers;
}

export function resolveCodexUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/codex/responses')) return trimmed;
  if (trimmed.endsWith('/codex')) return `${trimmed}/responses`;
  return `${trimmed}/codex/responses`;
}

type SseEvent = Record<string, unknown> & { type?: string };

async function* parseSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLines = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join('\n').trim();
          if (data && data !== '[DONE]') {
            try {
              yield JSON.parse(data) as SseEvent;
            } catch {
              // ignore malformed keep-alive frames
            }
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type CodexErrorPayload = {
  error?: {
    code?: string;
    type?: string;
    message?: string;
    plan_type?: string;
    resets_at?: number;
  };
  detail?: string;
};

const CHATGPT_ACCOUNT_SAFE_MODEL_HINT =
  'gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2';

function friendlyError(status: number, raw: string): Error {
  let message = raw || 'Codex request failed';
  try {
    const parsed = JSON.parse(raw) as CodexErrorPayload;
    const err = parsed.error;
    if (err) {
      const code = err.code ?? err.type ?? '';
      if (
        status === 429 ||
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)
      ) {
        const plan = err.plan_type
          ? ` (${err.plan_type.toLowerCase()} plan)`
          : '';
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : '';
        return new Error(`ChatGPT usage limit reached${plan}.${when}`.trim());
      }
      message = err.message ?? message;
    }
    if (typeof parsed.detail === 'string' && parsed.detail.length > 0) {
      message = parsed.detail;
    }
  } catch {
    // use raw text
  }
  if (/not supported when using Codex with a ChatGPT account/i.test(message)) {
    return new Error(
      `${message} Try one of: ${CHATGPT_ACCOUNT_SAFE_MODEL_HINT} — or omit the model to let ergo pick a safe default.`,
    );
  }
  return new Error(`Codex backend error ${status}: ${message}`);
}

// A ModelClient backed by the ChatGPT-account Codex responses endpoint. This is
// the "bring your own ChatGPT subscription" path: no per-token API billing, the
// user's existing Plus/Pro/Team plan covers it.
export function createCodexClient(config: CodexClientConfig): ModelClient {
  const baseUrl =
    config.baseUrl || 'https://chatgpt.com/backend-api/codex/responses';
  return {
    provider: 'codex',
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const accountId =
        config.accountId.length > 0
          ? config.accountId
          : (extractAccountIdFromJwt(config.accessToken) ?? '');
      if (!accountId) {
        throw new Error(
          'Could not determine ChatGPT account id from OAuth credential. Re-run `ergo auth login`.',
        );
      }

      const instructions = [req.system, ...collectSystem(req.messages)]
        .filter((s): s is string => Boolean(s))
        .join('\n\n');

      const body: CodexRequestBody = {
        model: req.model,
        instructions: instructions || 'You are a helpful assistant.',
        input: buildCodexInput(req.messages),
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        parallel_tool_calls: false,
        tool_choice: 'auto',
        prompt_cache_key: config.sessionId,
      };
      if (req.reasoningEffort) {
        body.reasoning = { effort: req.reasoningEffort };
      }
      if (req.jsonSchema) {
        // The ChatGPT-account backend reliably honors json_object but not always
        // strict json_schema, so we request json_object and rely on the caller's
        // schema being embedded in the prompt for shape guidance.
        body.text = { format: { type: 'json_object' } };
      }

      const headers = buildCodexHeaders({ ...config, accountId });
      const url = resolveCodexUrl(baseUrl);
      const fetchImpl = config.fetchImpl ?? fetch;

      const response = await fetchCodexWithRetry(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: req.signal,
        },
        { sleep: config.sleepImpl, retry: config.retry },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw friendlyError(response.status, text);
      }

      let text = '';
      let reasoning = '';
      let finishReason = 'stop';
      let usage: ModelUsage | undefined;

      for await (const event of parseSse(response)) {
        const type = event.type;
        if (type === 'response.output_text.delta') {
          const delta = asString(event.delta) ?? '';
          if (delta) {
            text += delta;
            req.onTextDelta?.(delta);
          }
          continue;
        }
        if (type === 'response.reasoning_summary_text.delta') {
          const delta = asString(event.delta) ?? '';
          if (delta) {
            reasoning += delta;
            req.onReasoningDelta?.(delta);
          }
          continue;
        }
        if (
          type === 'response.completed' ||
          type === 'response.done' ||
          type === 'response.incomplete'
        ) {
          const resp = (
            event as {
              response?: {
                status?: string;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  input_tokens_details?: { cached_tokens?: number };
                  output_tokens_details?: { reasoning_tokens?: number };
                  // tolerate older flat shapes too
                  reasoning_tokens?: number;
                  cached_input_tokens?: number;
                };
              };
            }
          ).response;
          finishReason = resp?.status ?? 'stop';
          const u = resp?.usage;
          if (u) {
            usage = {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              reasoning:
                u.output_tokens_details?.reasoning_tokens ?? u.reasoning_tokens,
              cacheRead:
                u.input_tokens_details?.cached_tokens ?? u.cached_input_tokens,
            };
          }
          break;
        }
        if (type === 'response.failed') {
          const errPayload = (
            event as {
              response?: { error?: { code?: string; message?: string } };
            }
          ).response?.error;
          const code = errPayload?.code ?? '';
          const message = errPayload?.message ?? 'Codex response failed';
          if (
            /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(
              code,
            )
          ) {
            throw new Error(`ChatGPT usage limit reached: ${message}`);
          }
          throw new Error(message);
        }
        if (type === 'error') {
          const message =
            asString((event as { message?: unknown }).message) ?? 'Codex error';
          throw new Error(message);
        }
      }

      if (!usage) {
        const inputForEstimate = `${instructions}\n${req.messages
          .map((m) => m.content)
          .join('\n')}`;
        usage = estimateUsage(inputForEstimate, text);
      }

      return {
        text,
        reasoning: reasoning || undefined,
        usage,
        finishReason,
      };
    },
  };
}

function collectSystem(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'system').map((m) => m.content);
}
