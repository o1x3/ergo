// Inference-layer types shared across providers (Codex subscription, OpenAI,
// Anthropic, and OpenAI-compatible endpoints).

export type Provider = 'codex' | 'openai' | 'anthropic' | 'openai-compatible';

export type CredentialType = 'oauth' | 'api-key';

// A stored credential. For `codex` OAuth this holds the ChatGPT-account access
// token + refresh token; for API keys it holds the raw key. Never logged.
export interface CredentialRecord {
  provider: Provider;
  type: CredentialType;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
  baseUrl?: string;
  createdAt: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  estimated?: boolean;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  // JSON-schema (draft 2020-12 shape) the model output must conform to. When
  // set, clients request structured output and the caller can JSON.parse the
  // result text safely.
  jsonSchema?: Record<string, unknown>;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  reasoning?: string;
  usage?: ModelUsage;
  finishReason: string;
  // Provider rate-limit snapshot, when the backend reports it (Codex
  // subscription path). Undefined for providers that don't expose limits.
  rateLimits?: import('@/inference/ratelimits').RateLimitSnapshot;
}

export interface ModelClient {
  readonly provider: Provider;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
