import { z } from 'zod';

import type {
  ChatMessage,
  ModelClient,
  ModelUsage,
  ReasoningEffort,
} from '@/inference/types';

// Pull the first balanced JSON object/array out of a model response. Handles
// ```json fences, leading prose, and trailing chatter that some models emit
// even when asked for pure JSON.
export function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  const start = candidate.search(/[[{]/);
  if (start === -1) return undefined;

  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export type StructuredRequest<T> = {
  client: ModelClient;
  model: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  maxRepairAttempts?: number;
};

export type StructuredResult<T> = {
  value: T;
  usage?: ModelUsage;
  raw: string;
};

function combineUsage(
  a: ModelUsage | undefined,
  b: ModelUsage | undefined,
): ModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    estimated: a.estimated || b.estimated,
  };
}

// Run a structured completion and validate against a zod schema, repairing once
// or twice if the model returns malformed or schema-violating JSON.
export async function completeStructured<T>(
  req: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const maxRepairs = req.maxRepairAttempts ?? 2;
  let usage: ModelUsage | undefined;
  const messages = [...req.messages];

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    let resultText = '';
    let parsed: unknown;
    let parseError: string | undefined;

    // The ai-sdk `generateObject` path validates server-side and THROWS on a
    // schema/JSON violation rather than returning bad text, so we catch the
    // throw and route it through the same repair loop as a manual parse failure.
    try {
      const result = await req.client.complete({
        model: req.model,
        system: req.system,
        messages,
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        reasoningEffort: req.reasoningEffort,
        jsonSchema: req.jsonSchema,
        signal: req.signal,
      });
      usage = combineUsage(usage, result.usage);
      resultText = result.text;
      const jsonText = extractJson(result.text) ?? result.text.trim();
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }
      if (parseError === undefined) {
        const validation = req.schema.safeParse(parsed);
        if (validation.success) {
          return { value: validation.data, usage, raw: jsonText };
        }
        parseError = z.prettifyError(validation.error);
      }
    } catch (err) {
      // A genuine abort should not be swallowed by the repair loop.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      parseError = err instanceof Error ? err.message : String(err);
    }

    if (attempt === maxRepairs) {
      throw new Error(
        `Model did not return valid JSON matching the expected schema after ${maxRepairs + 1} attempts: ${parseError}`,
      );
    }

    // Feed the bad output back and ask for a corrected version.
    if (resultText) {
      messages.push({ role: 'assistant', content: resultText });
    }
    messages.push({
      role: 'user',
      content:
        `Your previous response was not valid JSON matching the required schema. ` +
        `Error: ${parseError}\n\n` +
        `Return ONLY the corrected JSON object, no prose, no markdown fences.`,
    });
  }

  // Unreachable: the loop returns or throws.
  throw new Error('completeStructured: exhausted attempts');
}
