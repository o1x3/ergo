import { z } from 'zod';

// Severity ladder, highest first. `suggestion` and `info` are non-blocking nits.
export const SEVERITIES = [
  'critical',
  'major',
  'minor',
  'suggestion',
  'info',
] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  major: 4,
  minor: 3,
  suggestion: 2,
  info: 1,
};

// Content categories a finding can belong to (one each), used for filtering,
// analytics, and SARIF tagging.
export const CATEGORIES = [
  'security',
  'correctness',
  'performance',
  'reliability',
  'data-integrity',
  'concurrency',
  'maintainability',
  'style',
  'testing',
  'documentation',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const findingSchema = z.object({
  file: z.string().describe('Repo-relative path of the changed file'),
  startLine: z
    .number()
    .int()
    .describe('First line of the issue in the NEW file (1-based)'),
  endLine: z
    .number()
    .int()
    .describe('Last line of the issue in the NEW file (>= startLine)'),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string().describe('Short, specific headline (<= 100 chars)'),
  description: z
    .string()
    .describe('Clear explanation of the problem and its impact'),
  rationale: z
    .string()
    .describe('Why this is genuinely a problem; the reasoning behind it'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('0.0-1.0 — how certain this is a real, actionable issue'),
  codegenInstructions: z
    .string()
    .describe('A precise instruction another AI agent could follow to fix it'),
  suggestedPatch: z
    .string()
    .optional()
    .describe(
      'Optional: exact replacement code for lines startLine..endLine (no diff markers, no fences)',
    ),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsResultSchema = z.object({
  findings: z.array(findingSchema),
});
export type FindingsResult = z.infer<typeof findingsResultSchema>;

export const fileSummarySchema = z.object({
  path: z.string(),
  summary: z.string().describe('One-line description of what changed and why'),
});

export const summaryResultSchema = z.object({
  summary: z
    .string()
    .describe('A concise high-level overview of the whole changeset'),
  walkthrough: z
    .string()
    .describe('A structured, sectioned explanation of the changes (markdown)'),
  fileSummaries: z.array(fileSummarySchema),
  effort: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('Estimated review effort/complexity, 1 (trivial) to 5 (hard)'),
  mergeConfidence: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('1 (risky) to 5 (safe to merge) overall risk assessment'),
  sequenceDiagram: z
    .string()
    .optional()
    .describe('Optional Mermaid diagram of the key flow, or empty if N/A'),
});
export type SummaryResult = z.infer<typeof summaryResultSchema>;

// A complete review: overall + per-finding. Findings carry an id assigned by the
// engine after generation (stable within a run).
export interface ReviewFinding extends Finding {
  id: string;
}

export interface ReviewResult {
  summary: SummaryResult;
  findings: ReviewFinding[];
  stats: ReviewStats;
}

export interface ReviewStats {
  filesReviewed: number;
  filesSkipped: number;
  // Files whose findings batch failed — the model never reviewed them, so the
  // review's coverage is PARTIAL. Consumers should treat them as un-covered.
  unreviewedFiles?: string[];
  additions: number;
  deletions: number;
  findingsBySeverity: Record<Severity, number>;
  tokensInput: number;
  tokensOutput: number;
  costUsd?: number;
  subscriptionCovered: boolean;
  model: string;
  provider: string;
  durationMs: number;
}

// JSON Schemas handed to the model for structured output. Derived from zod so
// they never drift from validation.
export const FINDINGS_JSON_SCHEMA = z.toJSONSchema(
  findingsResultSchema,
) as Record<string, unknown>;
export const SUMMARY_JSON_SCHEMA = z.toJSONSchema(
  summaryResultSchema,
) as Record<string, unknown>;

export function emptySeverityCounts(): Record<Severity, number> {
  return { critical: 0, major: 0, minor: 0, suggestion: 0, info: 0 };
}
