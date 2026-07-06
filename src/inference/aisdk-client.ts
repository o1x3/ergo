import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  streamText,
} from 'ai';

import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelClient,
  ModelUsage,
  Provider,
} from '@/inference/types';

export type AiSdkClientConfig = {
  provider: Exclude<Provider, 'codex'>;
  apiKey: string;
  baseUrl?: string;
};

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content })) as ModelMessage[];
}

function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const input =
    num(r.inputTokens) ?? num(r.input_tokens) ?? num(r.promptTokens);
  const output =
    num(r.outputTokens) ?? num(r.output_tokens) ?? num(r.completionTokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: num(r.reasoningTokens) ?? num(r.reasoning_tokens),
    cacheRead: num(r.cachedInputTokens) ?? num(r.cached_input_tokens),
    cacheWrite: num(r.cacheCreationInputTokens),
  };
}

function buildModel(
  config: AiSdkClientConfig,
  modelName: string,
): LanguageModel {
  if (config.provider === 'anthropic') {
    const provider = createAnthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    return provider(modelName);
  }
  // openai + openai-compatible share the OpenAI provider; the latter just
  // points baseURL elsewhere (Ollama, OpenRouter, vLLM, etc.).
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  return provider(modelName);
}

export function createAiSdkClient(config: AiSdkClientConfig): ModelClient {
  return {
    provider: config.provider,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = buildModel(config, req.model);
      const systemParts = [
        req.system,
        ...req.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content),
      ].filter((s): s is string => Boolean(s));
      // ai v7 renamed the top-level `system` option to `instructions`.
      const instructions = systemParts.join('\n\n') || undefined;
      const messages = toModelMessages(req.messages);

      // Structured output: use the SDK's native object generation, which routes
      // through provider-side JSON schema / tool calling for high reliability.
      // (`generateObject` is deprecated in ai v7 in favor of this form.)
      if (req.jsonSchema) {
        const result = await generateText({
          model,
          instructions,
          messages,
          output: Output.object({ schema: jsonSchema(req.jsonSchema) }),
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: req.signal,
        });
        const text = JSON.stringify(result.output);
        req.onTextDelta?.(text);
        return {
          text,
          usage: normalizeUsage(result.usage),
          finishReason: result.finishReason ?? 'stop',
        };
      }

      const result = streamText({
        model,
        instructions,
        messages,
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        abortSignal: req.signal,
      });

      let text = '';
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          text += chunk.text;
          req.onTextDelta?.(chunk.text);
        } else if (chunk.type === 'reasoning-delta') {
          req.onReasoningDelta?.(chunk.text);
        } else if (chunk.type === 'error') {
          // Provider/stream errors surface as an 'error' part; surface them
          // instead of silently returning a truncated/empty response.
          const e = (chunk as { error?: unknown }).error;
          throw e instanceof Error ? e : new Error(String(e));
        }
      }

      let usage: ModelUsage | undefined;
      try {
        usage = normalizeUsage(await result.usage);
      } catch {
        usage = undefined;
      }

      return {
        text,
        usage,
        finishReason: await result.finishReason,
      };
    },
  };
}
