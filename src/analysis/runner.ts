import { ALL_TOOLS } from '@/analysis/tools';
import type { StaticFinding, ToolSpec } from '@/analysis/types';
import type { DiffSet, FileDiff } from '@/git/diff';
import { commandExists, exec } from '@/util/exec';

export type ToolToggle = {
  enabled?: boolean;
  config_file?: string;
  level?: string | number;
};

export type AnalysisResult = {
  findings: StaticFinding[];
  groundingText?: string;
  ran: string[];
  skipped: { name: string; reason: string }[];
};

const TOOL_TIMEOUT_MS = 60_000;
const MAX_GROUNDING_FINDINGS = 80;
const MAX_TEXT_OUTPUT_CHARS = 4_000;

// Map file -> changed new-line ranges, so we only surface lint findings that
// actually touch this changeset (not pre-existing noise).
function changedLineRanges(file: FileDiff): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const h of file.hunks) {
    const start = h.newStart;
    const end = h.newStart + Math.max(0, h.newLines - 1);
    ranges.push([start, end]);
  }
  return ranges;
}

function lineIsChanged(
  ranges: Array<[number, number]>,
  line: number | undefined,
): boolean {
  if (line === undefined) return true; // file-level findings always count
  return ranges.some(([s, e]) => line >= s - 2 && line <= e + 2);
}

function isEnabled(
  tool: ToolSpec,
  toggles: Record<string, ToolToggle>,
): boolean {
  const t = toggles[tool.name];
  if (t?.enabled === false) return false;
  return true;
}

// Run all applicable, installed, enabled static-analysis tools on the changed
// files. Findings are filtered to the changed lines and normalized.
export async function runStaticAnalysis(
  diff: DiffSet,
  opts: {
    repoRoot: string;
    toggles?: Record<string, ToolToggle>;
    onSkip?: (name: string, reason: string) => void;
    enabled?: boolean;
  },
): Promise<AnalysisResult> {
  const toggles = opts.toggles ?? {};
  const result: AnalysisResult = {
    findings: [],
    ran: [],
    skipped: [],
  };
  if (opts.enabled === false) return result;

  const fileByPath = new Map(diff.files.map((f) => [f.path, f]));
  const changedRanges = new Map<string, Array<[number, number]>>();
  for (const f of diff.files) changedRanges.set(f.path, changedLineRanges(f));
  const textBlocks: string[] = [];

  for (const tool of ALL_TOOLS) {
    if (!isEnabled(tool, toggles)) continue;
    const applicable = diff.files.filter(
      (f) => !f.binary && tool.applies({ path: f.path, language: f.language }),
    );
    if (applicable.length === 0) continue;

    if (!(await commandExists(tool.bin))) {
      result.skipped.push({ name: tool.name, reason: 'not installed' });
      opts.onSkip?.(tool.name, 'not installed');
      continue;
    }

    const ctx = {
      repoRoot: opts.repoRoot,
      configFile: toggles[tool.name]?.config_file,
      level: toggles[tool.name]?.level,
    };
    const args = tool.buildArgs(
      applicable.map((f) => f.path),
      ctx,
    );
    if (!args) continue;

    let out: Awaited<ReturnType<typeof exec>>;
    try {
      out = await exec([tool.bin, ...args], {
        cwd: opts.repoRoot,
        timeoutMs: TOOL_TIMEOUT_MS,
      });
    } catch (err) {
      result.skipped.push({
        name: tool.name,
        reason: err instanceof Error ? err.message : 'failed to run',
      });
      continue;
    }

    result.ran.push(tool.name);

    if (tool.parse) {
      let parsed: StaticFinding[] = [];
      try {
        parsed = tool.parse(out, ctx);
      } catch {
        parsed = [];
      }
      for (const f of parsed) {
        // Normalize absolute paths back to repo-relative when possible.
        const rel = f.file.startsWith(opts.repoRoot)
          ? f.file.slice(opts.repoRoot.length).replace(/^\/+/, '')
          : f.file;
        if (!fileByPath.has(rel)) continue;
        if (!lineIsChanged(changedRanges.get(rel) ?? [], f.line)) continue;
        result.findings.push({ ...f, file: rel });
      }
    } else {
      // Text-only tool: surface its raw output (capped) as grounding so the
      // model can weigh it, even without a structured parser.
      const raw = `${out.stdout}\n${out.stderr}`.trim();
      if (raw && out.exitCode !== 0) {
        textBlocks.push(
          `### ${tool.name}\n${raw.slice(0, MAX_TEXT_OUTPUT_CHARS)}`,
        );
      }
    }
  }

  result.groundingText = renderGrounding(result.findings, textBlocks);
  return result;
}

function renderGrounding(
  findings: StaticFinding[],
  textBlocks: string[],
): string | undefined {
  const sections: string[] = [];
  if (findings.length > 0) {
    const lines = findings
      .slice(0, MAX_GROUNDING_FINDINGS)
      .map(
        (f) =>
          `- [${f.tool}${f.ruleId ? `:${f.ruleId}` : ''}] ${f.file}${
            f.line ? `:${f.line}` : ''
          } (${f.severity}) ${f.message}`,
      );
    if (findings.length > MAX_GROUNDING_FINDINGS) {
      lines.push(`- …and ${findings.length - MAX_GROUNDING_FINDINGS} more`);
    }
    sections.push(lines.join('\n'));
  }
  if (textBlocks.length > 0) sections.push(textBlocks.join('\n\n'));
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
