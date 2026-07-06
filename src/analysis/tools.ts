import type { StaticFinding, StaticSeverity, ToolSpec } from '@/analysis/types';

function byLang(...langs: string[]) {
  const set = new Set(langs);
  return (f: { language: string }) => set.has(f.language);
}

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

// ---- ruff (python) ----
const ruff: ToolSpec = {
  name: 'ruff',
  bin: 'ruff',
  category: 'lint',
  applies: byLang('python'),
  buildArgs: (files) => ['check', '--output-format', 'json', '--', ...files],
  parse: (out) => {
    const rows = safeJson<
      Array<{
        filename: string;
        location?: { row?: number; column?: number };
        end_location?: { row?: number };
        code?: string;
        message?: string;
      }>
    >(out.stdout);
    if (!rows) return [];
    return rows.map((r) => ({
      tool: 'ruff',
      file: r.filename,
      line: r.location?.row,
      endLine: r.end_location?.row,
      column: r.location?.column,
      ruleId: r.code,
      severity: 'warning' as StaticSeverity,
      message: r.message ?? '',
    }));
  },
};

// ---- eslint (js/ts) ----
const eslint: ToolSpec = {
  name: 'eslint',
  bin: 'eslint',
  category: 'lint',
  applies: byLang('javascript', 'typescript', 'jsx', 'tsx'),
  buildArgs: (files) => [
    '-f',
    'json',
    '--no-error-on-unmatched-pattern',
    ...files,
  ],
  parse: (out) => {
    const rows = safeJson<
      Array<{
        filePath: string;
        messages?: Array<{
          ruleId?: string | null;
          severity?: number;
          message?: string;
          line?: number;
          endLine?: number;
          column?: number;
        }>;
      }>
    >(out.stdout);
    if (!rows) return [];
    const findings: StaticFinding[] = [];
    for (const file of rows) {
      for (const m of file.messages ?? []) {
        findings.push({
          tool: 'eslint',
          file: file.filePath,
          line: m.line,
          endLine: m.endLine,
          column: m.column,
          ruleId: m.ruleId ?? undefined,
          severity: m.severity === 2 ? 'error' : 'warning',
          message: m.message ?? '',
        });
      }
    }
    return findings;
  },
};

// ---- shellcheck (shell) ----
const shellcheck: ToolSpec = {
  name: 'shellcheck',
  bin: 'shellcheck',
  category: 'lint',
  applies: byLang('shell'),
  buildArgs: (files) => ['-f', 'json', ...files],
  parse: (out) => {
    const rows = safeJson<
      Array<{
        file: string;
        line?: number;
        endLine?: number;
        column?: number;
        level?: string;
        code?: number;
        message?: string;
      }>
    >(out.stdout);
    if (!rows) return [];
    return rows.map((r) => ({
      tool: 'shellcheck',
      file: r.file,
      line: r.line,
      endLine: r.endLine,
      column: r.column,
      ruleId: r.code ? `SC${r.code}` : undefined,
      severity:
        r.level === 'error'
          ? ('error' as StaticSeverity)
          : r.level === 'info' || r.level === 'style'
            ? ('info' as StaticSeverity)
            : ('warning' as StaticSeverity),
      message: r.message ?? '',
    }));
  },
};

// ---- semgrep (multi) ----
const semgrep: ToolSpec = {
  name: 'semgrep',
  bin: 'semgrep',
  category: 'security',
  applies: byLang(
    'python',
    'javascript',
    'typescript',
    'go',
    'java',
    'ruby',
    'tsx',
    'jsx',
  ),
  buildArgs: (files, ctx) => {
    const cfg = ctx.configFile
      ? ['--config', ctx.configFile]
      : ['--config', 'auto'];
    return [...cfg, '--json', '--quiet', '--no-git-ignore', ...files];
  },
  parse: (out) => {
    const data = safeJson<{
      results?: Array<{
        path?: string;
        start?: { line?: number; col?: number };
        end?: { line?: number };
        check_id?: string;
        extra?: { message?: string; severity?: string };
      }>;
    }>(out.stdout);
    if (!data?.results) return [];
    return data.results.map((r) => ({
      tool: 'semgrep',
      file: r.path ?? '',
      line: r.start?.line,
      endLine: r.end?.line,
      column: r.start?.col,
      ruleId: r.check_id,
      severity:
        r.extra?.severity === 'ERROR'
          ? ('error' as StaticSeverity)
          : ('warning' as StaticSeverity),
      message: r.extra?.message ?? '',
    }));
  },
};

// ---- hadolint (dockerfile) ----
const hadolint: ToolSpec = {
  name: 'hadolint',
  bin: 'hadolint',
  category: 'lint',
  applies: byLang('dockerfile'),
  buildArgs: (files) => ['-f', 'json', ...files],
  parse: (out) => {
    const rows = safeJson<
      Array<{
        file?: string;
        line?: number;
        column?: number;
        level?: string;
        code?: string;
        message?: string;
      }>
    >(out.stdout);
    if (!rows) return [];
    return rows.map((r) => ({
      tool: 'hadolint',
      file: r.file ?? '',
      line: r.line,
      column: r.column,
      ruleId: r.code,
      severity:
        r.level === 'error'
          ? ('error' as StaticSeverity)
          : r.level === 'info' || r.level === 'style'
            ? ('info' as StaticSeverity)
            : ('warning' as StaticSeverity),
      message: r.message ?? '',
    }));
  },
};

// ---- yamllint (yaml) ----
const yamllint: ToolSpec = {
  name: 'yamllint',
  bin: 'yamllint',
  category: 'lint',
  applies: byLang('yaml'),
  buildArgs: (files) => ['-f', 'parsable', ...files],
  parse: (out) => {
    const findings: StaticFinding[] = [];
    // file:line:col: [level] message (rule)
    const re = /^(.+?):(\d+):(\d+):\s+\[(\w+)\]\s+(.*?)(?:\s+\((.+?)\))?$/;
    for (const line of out.stdout.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      findings.push({
        tool: 'yamllint',
        file: m[1]!,
        line: num(Number(m[2])),
        column: num(Number(m[3])),
        ruleId: m[6],
        severity: m[4] === 'error' ? 'error' : 'warning',
        message: m[5] ?? '',
      });
    }
    return findings;
  },
};

// ---- mypy (python types) ----
const mypy: ToolSpec = {
  name: 'mypy',
  bin: 'mypy',
  category: 'type',
  applies: byLang('python'),
  buildArgs: (files) => [
    '--no-error-summary',
    '--show-column-numbers',
    '--no-color-output',
    ...files,
  ],
  parse: (out) => {
    const findings: StaticFinding[] = [];
    // file:line:col: error: message [code]
    const re =
      /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning|note):\s+(.*?)(?:\s+\[(.+?)\])?$/;
    for (const line of out.stdout.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      findings.push({
        tool: 'mypy',
        file: m[1]!,
        line: num(Number(m[2])),
        column: m[3] ? num(Number(m[3])) : undefined,
        ruleId: m[6],
        severity:
          m[4] === 'error' ? 'error' : m[4] === 'note' ? 'info' : 'warning',
        message: m[5] ?? '',
      });
    }
    return findings;
  },
};

// ---- gitleaks (secrets) ----
const gitleaks: ToolSpec = {
  name: 'gitleaks',
  bin: 'gitleaks',
  category: 'secrets',
  applies: () => true,
  // v8.19+ replaced `detect --no-git` with the `dir` command; older versions
  // don't know `dir`, so the legacy invocation rides in altArgs.
  buildArgs: (_files, ctx) => [
    'dir',
    ctx.repoRoot,
    '--report-format',
    'json',
    '--report-path',
    '/dev/stdout',
  ],
  altArgs: (_files, ctx) => [
    'detect',
    '--no-git',
    '--report-format',
    'json',
    '--report-path',
    '/dev/stdout',
    '--source',
    ctx.repoRoot,
  ],
  parse: (out) => {
    const rows = safeJson<
      Array<{
        File?: string;
        StartLine?: number;
        RuleID?: string;
        Description?: string;
      }>
    >(out.stdout);
    if (!rows) return [];
    return rows.map((r) => ({
      tool: 'gitleaks',
      file: r.File ?? '',
      line: r.StartLine,
      ruleId: r.RuleID,
      severity: 'error' as StaticSeverity,
      message: r.Description ?? 'Potential secret detected',
    }));
  },
};

// ---- golangci-lint (go) ----
const golangciLint: ToolSpec = {
  name: 'golangci-lint',
  bin: 'golangci-lint',
  category: 'lint',
  applies: byLang('go'),
  // v2 renamed --out-format to --output.json.path; v1 syntax lives in altArgs.
  buildArgs: (_files, ctx) => {
    const cfg = ctx.configFile ? ['-c', ctx.configFile] : [];
    return ['run', '--output.json.path', 'stdout', ...cfg];
  },
  altArgs: (_files, ctx) => {
    const cfg = ctx.configFile ? ['-c', ctx.configFile] : [];
    return ['run', '--out-format', 'json', ...cfg];
  },
  parse: (out) => {
    const data = safeJson<{
      Issues?: Array<{
        FromLinter?: string;
        Text?: string;
        Severity?: string;
        Pos?: { Filename?: string; Line?: number; Column?: number };
      }>;
    }>(out.stdout);
    if (!data?.Issues) return [];
    return data.Issues.map((i) => ({
      tool: 'golangci-lint',
      file: i.Pos?.Filename ?? '',
      line: i.Pos?.Line,
      column: i.Pos?.Column,
      ruleId: i.FromLinter,
      severity: i.Severity === 'error' ? 'error' : 'warning',
      message: i.Text ?? '',
    }));
  },
};

// ---- rubocop (ruby) ----
const rubocop: ToolSpec = {
  name: 'rubocop',
  bin: 'rubocop',
  category: 'lint',
  applies: byLang('ruby'),
  buildArgs: (files) => ['--format', 'json', ...files],
  parse: (out) => {
    const data = safeJson<{
      files?: Array<{
        path?: string;
        offenses?: Array<{
          severity?: string;
          message?: string;
          cop_name?: string;
          location?: { start_line?: number; line?: number; column?: number };
        }>;
      }>;
    }>(out.stdout);
    if (!data?.files) return [];
    const findings: StaticFinding[] = [];
    for (const f of data.files) {
      for (const o of f.offenses ?? []) {
        findings.push({
          tool: 'rubocop',
          file: f.path ?? '',
          line: o.location?.start_line ?? o.location?.line,
          column: o.location?.column,
          ruleId: o.cop_name,
          severity:
            o.severity === 'error' || o.severity === 'fatal'
              ? 'error'
              : o.severity === 'convention' || o.severity === 'refactor'
                ? 'info'
                : 'warning',
          message: o.message ?? '',
        });
      }
    }
    return findings;
  },
};

// ---- actionlint (github actions) ----
const actionlint: ToolSpec = {
  name: 'actionlint',
  bin: 'actionlint',
  category: 'lint',
  applies: byLang('yaml'),
  buildArgs: (files) => {
    const wf = files.filter((f) => /\.github\/workflows\//.test(f));
    return wf.length ? ['-format', '{{json .}}', ...wf] : null;
  },
  parse: (out) => {
    const rows = safeJson<
      Array<{
        message?: string;
        filepath?: string;
        line?: number;
        column?: number;
        kind?: string;
      }>
    >(out.stdout);
    if (!rows) return [];
    return rows.map((r) => ({
      tool: 'actionlint',
      file: r.filepath ?? '',
      line: r.line,
      column: r.column,
      ruleId: r.kind,
      severity: 'warning' as StaticSeverity,
      message: r.message ?? '',
    }));
  },
};

// ---- stylelint (css/scss) ----
const stylelint: ToolSpec = {
  name: 'stylelint',
  bin: 'stylelint',
  category: 'lint',
  applies: byLang('css', 'scss'),
  buildArgs: (files) => ['--formatter', 'json', ...files],
  parse: (out) => {
    const rows = safeJson<
      Array<{
        source?: string;
        warnings?: Array<{
          line?: number;
          column?: number;
          rule?: string;
          severity?: string;
          text?: string;
        }>;
      }>
    >(out.stdout);
    if (!rows) return [];
    const findings: StaticFinding[] = [];
    for (const f of rows) {
      for (const w of f.warnings ?? []) {
        findings.push({
          tool: 'stylelint',
          file: f.source ?? '',
          line: w.line,
          column: w.column,
          ruleId: w.rule,
          severity: w.severity === 'error' ? 'error' : 'warning',
          message: w.text ?? '',
        });
      }
    }
    return findings;
  },
};

// Text-only tools: their raw output is surfaced to the LLM as grounding without
// structured parsing. Kept lean; each can gain a parser later.
function textTool(
  name: string,
  bin: string,
  category: ToolSpec['category'],
  applies: ToolSpec['applies'],
  buildArgs: ToolSpec['buildArgs'],
): ToolSpec {
  return { name, bin, category, applies, buildArgs };
}

const TEXT_TOOLS: ToolSpec[] = [
  textTool(
    'markdownlint',
    'markdownlint',
    'prose',
    byLang('markdown'),
    (files) => [...files],
  ),
  textTool('clippy', 'cargo-clippy', 'lint', byLang('rust'), () => [
    '--message-format',
    'short',
  ]),
];

export const ALL_TOOLS: ToolSpec[] = [
  ruff,
  eslint,
  shellcheck,
  semgrep,
  hadolint,
  yamllint,
  mypy,
  gitleaks,
  golangciLint,
  rubocop,
  actionlint,
  stylelint,
  ...TEXT_TOOLS,
];

export function getToolByName(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
