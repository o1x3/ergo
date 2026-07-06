import { z } from 'zod';

// .ergo.yaml schema. Permissive by design: unknown keys pass through so a newer
// config doesn't break an older binary, and every section is optional with sane
// defaults applied at load time. Mirrors CodeRabbit's .coderabbit.yaml + cubic's
// cubic.yaml, plus ergo extensions.

const pathInstruction = z.object({
  path: z.string(),
  instructions: z.string(),
});

const toolConfig = z
  .object({
    enabled: z.boolean().optional(),
    config_file: z.string().optional(),
    level: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const modelSchema = z
  .object({
    provider: z
      .enum(['codex', 'openai', 'anthropic', 'openai-compatible'])
      .optional(),
    default: z.string().optional(),
    triage: z.string().optional(),
    deep: z.string().optional(),
    self_hosted_url: z.string().optional(),
    base_url: z.string().optional(),
    max_budget_usd: z.number().optional(),
    temperature: z.number().optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  })
  .passthrough();

const ignoreSchema = z
  .object({
    files: z.array(z.string()).optional(),
    head_branches: z.array(z.string()).optional(),
    base_branches: z.array(z.string()).optional(),
    pr_labels: z.array(z.string()).optional(),
    pr_titles: z.array(z.string()).optional(),
    max_changed_lines: z.number().optional(),
    ignore_usernames: z.array(z.string()).optional(),
    honor_linguist_generated: z.boolean().optional(),
  })
  .passthrough();

const reviewsSchema = z
  .object({
    enabled: z.boolean().optional(),
    profile: z.enum(['chill', 'assertive']).optional(),
    sensitivity: z.enum(['low', 'medium', 'high']).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    type_verify: z.boolean().optional(),
    whole_repo_context: z.boolean().optional(),
    history_context: z.boolean().optional(),
    incremental: z.boolean().optional(),
    file_limit: z.number().optional(),
    ultra_file_limit: z.number().optional(),
    high_level_summary: z.boolean().optional(),
    changed_files_summary: z.boolean().optional(),
    sequence_diagrams: z.boolean().optional(),
    estimate_code_review_effort: z.boolean().optional(),
    merge_confidence: z.boolean().optional(),
    enable_prompt_for_ai_agents: z.boolean().optional(),
    assess_linked_issues: z.boolean().optional(),
    path_filters: z.array(z.string()).optional(),
    path_instructions: z.array(pathInstruction).optional(),
    ignore: ignoreSchema.optional(),
    tools: z.record(z.string(), toolConfig).optional(),
    custom_agents: z
      .array(
        z
          .object({
            name: z.string(),
            enabled: z.boolean().optional(),
            instructions: z.string(),
            file_paths: z.array(z.string()).optional(),
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const knowledgeBaseSchema = z
  .object({
    opt_out: z.boolean().optional(),
    web_search: z
      .object({ enabled: z.boolean().optional() })
      .passthrough()
      .optional(),
    code_guidelines: z
      .object({
        enabled: z.boolean().optional(),
        filePatterns: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    context_files: z
      .object({
        enabled: z.boolean().optional(),
        patterns: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    learnings: z
      .object({
        scope: z.enum(['local', 'global', 'auto']).optional(),
        approval_delay: z.number().optional(),
        senior_reviewers: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const outputSchema = z
  .object({
    default_format: z
      .enum(['pretty', 'plain', 'json', 'agent', 'sarif', 'markdown'])
      .optional(),
    color: z.enum(['auto', 'always', 'never']).optional(),
    markdown_diagrams: z.boolean().optional(),
  })
  .passthrough();

export const ergoConfigSchema = z
  .object({
    version: z.number().optional(),
    language: z.string().optional(),
    tone_instructions: z.string().max(250).optional(),
    early_access: z.boolean().optional(),
    inheritance: z.boolean().optional(),
    model: modelSchema.optional(),
    reviews: reviewsSchema.optional(),
    knowledge_base: knowledgeBaseSchema.optional(),
    output: outputSchema.optional(),
  })
  .passthrough();

export type ErgoConfig = z.infer<typeof ergoConfigSchema>;

// Effective, fully-resolved config used by the engine (defaults applied).
export interface ResolvedConfig {
  language: string;
  toneInstructions?: string;
  model: {
    provider?: 'codex' | 'openai' | 'anthropic' | 'openai-compatible';
    default?: string;
    triage?: string;
    deep?: string;
    baseUrl?: string;
    maxBudgetUsd: number;
    temperature?: number;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  };
  reviews: {
    enabled: boolean;
    profile: 'chill' | 'assertive';
    minConfidence: number;
    incremental: boolean;
    fileLimit: number;
    ultraFileLimit: number;
    highLevelSummary: boolean;
    sequenceDiagrams: boolean;
    pathFilters: string[];
    pathInstructions: { path: string; instructions: string }[];
    ignoreFiles: string[];
    maxChangedLines: number;
    honorLinguistGenerated: boolean;
    tools: Record<
      string,
      { enabled?: boolean; config_file?: string; level?: string | number }
    >;
    customAgents: {
      name: string;
      enabled?: boolean;
      instructions: string;
      include?: string[];
      exclude?: string[];
    }[];
  };
  knowledgeBase: {
    optOut: boolean;
    contextFiles: { enabled: boolean; patterns: string[] };
    codeGuidelines: { enabled: boolean; filePatterns: string[] };
    learningsScope: 'local' | 'global' | 'auto';
  };
  output: {
    defaultFormat: 'pretty' | 'plain' | 'json' | 'agent' | 'sarif' | 'markdown';
    color: 'auto' | 'always' | 'never';
  };
  raw: ErgoConfig;
}

const DEFAULT_CONTEXT_PATTERNS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.cursor/rules/**',
  'CONTRIBUTING.md',
  '.ai/**',
];

// sensitivity (cubic) maps onto profile + min_confidence (CodeRabbit).
function profileFrom(reviews: ErgoConfig['reviews']): {
  profile: 'chill' | 'assertive';
  minConfidence: number;
} {
  if (reviews?.profile) {
    return {
      profile: reviews.profile,
      minConfidence: reviews.min_confidence ?? 0.6,
    };
  }
  const sens = reviews?.sensitivity;
  if (sens === 'high')
    return {
      profile: 'assertive',
      minConfidence: reviews?.min_confidence ?? 0.5,
    };
  if (sens === 'low')
    return { profile: 'chill', minConfidence: reviews?.min_confidence ?? 0.75 };
  return { profile: 'chill', minConfidence: reviews?.min_confidence ?? 0.6 };
}

export function resolveConfig(config: ErgoConfig): ResolvedConfig {
  const reviews = config.reviews ?? {};
  const { profile, minConfidence } = profileFrom(reviews);
  const kb = config.knowledge_base ?? {};
  return {
    language: config.language ?? 'en-US',
    toneInstructions: config.tone_instructions,
    model: {
      provider: config.model?.provider,
      default: config.model?.default,
      triage: config.model?.triage,
      deep: config.model?.deep,
      baseUrl: config.model?.base_url ?? config.model?.self_hosted_url,
      maxBudgetUsd: config.model?.max_budget_usd ?? 0,
      temperature: config.model?.temperature,
      reasoningEffort: config.model?.reasoning_effort,
    },
    reviews: {
      enabled: reviews.enabled ?? true,
      profile,
      minConfidence,
      incremental: reviews.incremental ?? true,
      fileLimit: reviews.file_limit ?? 100,
      ultraFileLimit: reviews.ultra_file_limit ?? 250,
      highLevelSummary: reviews.high_level_summary ?? true,
      sequenceDiagrams: reviews.sequence_diagrams ?? true,
      pathFilters: reviews.path_filters ?? [],
      pathInstructions: reviews.path_instructions ?? [],
      ignoreFiles: reviews.ignore?.files ?? [],
      maxChangedLines: reviews.ignore?.max_changed_lines ?? 0,
      honorLinguistGenerated: reviews.ignore?.honor_linguist_generated ?? true,
      tools: reviews.tools ?? {},
      // `file_paths` is the cubic-style spelling of `include`; fold it in so
      // both forms actually scope the agent.
      customAgents: (reviews.custom_agents ?? []).map((a) => ({
        ...a,
        include: a.include ?? a.file_paths,
      })),
    },
    knowledgeBase: {
      optOut: kb.opt_out ?? false,
      contextFiles: {
        enabled: kb.context_files?.enabled ?? true,
        patterns: kb.context_files?.patterns ?? DEFAULT_CONTEXT_PATTERNS,
      },
      codeGuidelines: {
        enabled: kb.code_guidelines?.enabled ?? true,
        filePatterns: kb.code_guidelines?.filePatterns ?? [
          '**/CONTRIBUTING.md',
          '.cursor/rules/**',
          'AGENTS.md',
          'CLAUDE.md',
        ],
      },
      learningsScope: kb.learnings?.scope ?? 'auto',
    },
    output: {
      defaultFormat: config.output?.default_format ?? 'pretty',
      color: config.output?.color ?? 'auto',
    },
    raw: config,
  };
}
