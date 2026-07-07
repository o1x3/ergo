import { ALL_TOOLS } from '@/analysis/tools';
import type { StaticFinding, ToolSpec } from '@/analysis/types';
import type { DiffSet, FileDiff } from '@/git/diff';
import { mapLimit } from '@/util/concurrency';
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
const TOOL_CONCURRENCY = 4;
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

  // One outcome per tool; tools run concurrently (independent processes) and
  // the outcomes are assembled in ALL_TOOLS order so output is deterministic.
  type ToolOutcome =
    | { kind: 'inapplicable' }
    | { kind: 'skipped'; reason: string }
    | { kind: 'findings'; findings: StaticFinding[] }
    | { kind: 'text'; block?: string };

  const runTool = async (tool: ToolSpec): Promise<ToolOutcome> => {
    if (!isEnabled(tool, toggles)) return { kind: 'inapplicable' };
    const applicable = diff.files.filter(
      (f) => !f.binary && tool.applies({ path: f.path, language: f.language }),
    );
    if (applicable.length === 0) return { kind: 'inapplicable' };

    if (!(await commandExists(tool.bin))) {
      return { kind: 'skipped', reason: 'not installed' };
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
    if (!args) return { kind: 'inapplicable' };

    let out: Awaited<ReturnType<typeof exec>>;
    try {
      out = await exec([tool.bin, ...args], {
        cwd: opts.repoRoot,
        timeoutMs: TOOL_TIMEOUT_MS,
      });
      // A usage error means the installed CLI doesn't speak these flags
      // (version drift). Retry the legacy invocation once, and if that also
      // fails, record the tool as skipped rather than pretending it ran.
      if (looksLikeUsageError(out)) {
        const alt = tool.altArgs?.(
          applicable.map((f) => f.path),
          ctx,
        );
        out = alt
          ? await exec([tool.bin, ...alt], {
              cwd: opts.repoRoot,
              timeoutMs: TOOL_TIMEOUT_MS,
            })
          : out;
        if (looksLikeUsageError(out)) {
          return {
            kind: 'skipped',
            reason: `incompatible CLI version (${firstLine(out.stderr)})`,
          };
        }
      }
    } catch (err) {
      return {
        kind: 'skipped',
        reason: err instanceof Error ? err.message : 'failed to run',
      };
    }

    // A timed-out tool produced partial (or no) output — reporting it as
    // "ran" would silently drop its findings.
    if (out.exitCode === 124) {
      return {
        kind: 'skipped',
        reason: `timed out after ${TOOL_TIMEOUT_MS / 1000}s`,
      };
    }

    if (tool.parse) {
      let parsed: StaticFinding[] = [];
      try {
        parsed = tool.parse(out, ctx);
      } catch {
        parsed = [];
      }
      const rootPrefix = opts.repoRoot.endsWith('/')
        ? opts.repoRoot
        : `${opts.repoRoot}/`;
      const findings: StaticFinding[] = [];
      for (const f of parsed) {
        // Normalize absolute paths back to repo-relative when possible.
        const rel = f.file.startsWith(rootPrefix)
          ? f.file.slice(rootPrefix.length)
          : f.file;
        if (!fileByPath.has(rel)) continue;
        if (!lineIsChanged(changedRanges.get(rel) ?? [], f.line)) continue;
        findings.push({ ...f, file: rel });
      }
      return { kind: 'findings', findings };
    }

    // Text-only tool: surface its raw output (capped) as grounding so the
    // model can weigh it, even without a structured parser.
    const raw = `${out.stdout}\n${out.stderr}`.trim();
    return {
      kind: 'text',
      block:
        raw && out.exitCode !== 0
          ? `### ${tool.name}\n${raw.slice(0, MAX_TEXT_OUTPUT_CHARS)}`
          : undefined,
    };
  };

  // Per-file linters run concurrently; whole-repo scanners (tool.serial) run
  // one at a time afterwards so they never observe sibling tools' transient
  // state or contend on repo-wide locks.
  const outcomes: ToolOutcome[] = new Array(ALL_TOOLS.length);
  const concurrentIdx = ALL_TOOLS.flatMap((t, i) => (t.serial ? [] : [i]));
  const serialIdx = ALL_TOOLS.flatMap((t, i) => (t.serial ? [i] : []));
  const concurrentOutcomes = await mapLimit(
    concurrentIdx,
    TOOL_CONCURRENCY,
    (i) => runTool(ALL_TOOLS[i] as ToolSpec),
  );
  concurrentIdx.forEach((toolIdx, k) => {
    outcomes[toolIdx] = concurrentOutcomes[k] as ToolOutcome;
  });
  for (const i of serialIdx) {
    outcomes[i] = await runTool(ALL_TOOLS[i] as ToolSpec);
  }

  const textBlocks: string[] = [];
  for (let i = 0; i < ALL_TOOLS.length; i++) {
    const tool = ALL_TOOLS[i] as ToolSpec;
    const outcome = outcomes[i] as ToolOutcome;
    switch (outcome.kind) {
      case 'inapplicable':
        break;
      case 'skipped':
        result.skipped.push({ name: tool.name, reason: outcome.reason });
        opts.onSkip?.(tool.name, outcome.reason);
        break;
      case 'findings':
        result.ran.push(tool.name);
        result.findings.push(...outcome.findings);
        break;
      case 'text':
        result.ran.push(tool.name);
        if (outcome.block) textBlocks.push(outcome.block);
        break;
    }
  }

  result.groundingText = renderGrounding(result.findings, textBlocks);
  return result;
}

// Heuristic: the CLI rejected our arguments (wrong version), as opposed to a
// normal "findings exist" non-zero exit.
function looksLikeUsageError(out: {
  exitCode: number;
  stderr: string;
}): boolean {
  if (out.exitCode === 0) return false;
  return /unknown (?:flag|shorthand flag|command|option)|unrecognized option|unknown output format/i.test(
    out.stderr,
  );
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0]?.slice(0, 200) ?? '';
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
