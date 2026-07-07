export type StaticSeverity = 'error' | 'warning' | 'info';

// A normalized static-analysis finding. Grounds the LLM review and feeds SARIF.
export interface StaticFinding {
  tool: string;
  file: string;
  line?: number;
  endLine?: number;
  column?: number;
  ruleId?: string;
  severity: StaticSeverity;
  message: string;
}

export interface ToolRunContext {
  repoRoot: string;
  configFile?: string;
  level?: string | number;
}

export interface ToolOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ToolSpec {
  name: string;
  bin: string;
  // Which changed files this tool should run on.
  applies(file: { path: string; language: string }): boolean;
  // Build the argv (after `bin`) for the applicable files. Return null to skip.
  buildArgs(files: string[], ctx: ToolRunContext): string[] | null;
  // Fallback argv for older CLI versions, tried when the primary args fail
  // with a usage error (unknown flag/command) — e.g. golangci-lint v1 vs v2.
  altArgs?(files: string[], ctx: ToolRunContext): string[] | null;
  // Parse output to findings. If omitted, raw output is surfaced as text only.
  parse?(out: ToolOutput, ctx: ToolRunContext): StaticFinding[];
  // Config files that, if present, are auto-discovered and passed along.
  configFiles?: string[];
  // Whole-repo scanners (gitleaks, golangci-lint, cargo clippy) run serially,
  // after the per-file tools — concurrent repo-wide scans contend on locks and
  // can observe sibling tools' transient files.
  serial?: boolean;
  // Run once over the whole set (true) vs per-file batching is handled upstream.
  category: 'lint' | 'security' | 'type' | 'secrets' | 'iac' | 'prose';
}
