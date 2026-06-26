import {
  chip,
  confMeter,
  rule,
  section,
  sevGlyph,
  type Tone,
} from '@/output/layout';
import {
  renderInlineMarkdown,
  renderMarkdownTerminal,
} from '@/output/markdown-term';
import { stripControl, truncate, wrapText } from '@/output/style';
import type { ReviewFinding, ReviewResult, Severity } from '@/review/schema';
import { pc } from '@/util/logger';

const W = 70;

const SEVERITY_ORDER: Severity[] = [
  'critical',
  'major',
  'minor',
  'suggestion',
  'info',
];

// Colored "N severity" tally segment (no background), per severity.
const TALLY_STYLE: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.red(pc.bold(s)),
  major: (s) => pc.red(s),
  minor: (s) => pc.yellow(s),
  suggestion: (s) => pc.blue(s),
  info: (s) => pc.dim(s),
};

// Strip terminal control/escape sequences from model-supplied text so a crafted
// diff/finding can't move the cursor, recolor, or inject escapes.
const clean = stripControl;

const margin = (line: string): string => `  ${line}`;

// Render a full review for humans. `plain` keeps it pipe-friendly (drops the
// rendered walkthrough; color is handled by picocolors based on the stream).
export function renderTerminal(
  review: ReviewResult,
  options: { plain?: boolean } = {},
): string {
  const out: string[] = [];
  const { summary, findings, stats } = review;

  // Header
  out.push('');
  out.push(pc.cyan(pc.bold('  ergo review')));
  out.push(margin(rule(W)));

  if (summary.summary) {
    out.push('');
    out.push(margin(pc.bold('Summary')));
    for (const l of wrapText(
      renderInlineMarkdown(clean(summary.summary)),
      W - 2,
    ))
      out.push(margin(l));
  }

  if (summary.fileSummaries.length > 0) {
    out.push('');
    out.push(margin(pc.bold('Changed files')));
    for (const f of summary.fileSummaries) {
      out.push(
        margin(
          truncate(
            `${pc.cyan(clean(f.path))} ${pc.dim('—')} ${renderInlineMarkdown(clean(f.summary))}`,
            W,
          ),
        ),
      );
    }
  }

  if (summary.walkthrough && !options.plain) {
    out.push('');
    out.push(margin(pc.bold('Walkthrough')));
    for (const l of renderMarkdownTerminal(clean(summary.walkthrough)).split(
      '\n',
    ))
      out.push(margin(l));
  }

  if (summary.sequenceDiagram?.trim()) {
    out.push('');
    out.push(margin(pc.bold('Sequence diagram')));
    out.push(margin('```mermaid'));
    for (const l of clean(summary.sequenceDiagram.trim()).split('\n'))
      out.push(margin(l));
    out.push(margin('```'));
  }

  // Findings
  out.push('');
  if (findings.length === 0) {
    out.push(margin(rule(W)));
    out.push(margin(pc.green('✓  No issues found.')));
  } else {
    const sorted = [...findings].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    for (const l of section('Findings', {
      width: W,
      right: tally(sorted),
      rule: true,
    }))
      out.push(margin(l));
    const sevWordW = Math.max(...sorted.map((f) => f.severity.length)); // uppercased length == length
    for (const f of sorted) {
      out.push('');
      for (const l of renderFinding(f, sevWordW)) out.push(l);
    }
  }

  // Footer / stats
  out.push('');
  out.push(margin(rule(W)));
  const sevCounts = Object.entries(stats.findingsBySeverity)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
  out.push(
    margin(
      truncate(
        pc.dim(
          `${stats.filesReviewed} file(s) reviewed · +${stats.additions}/-${stats.deletions}` +
            (sevCounts ? ` · ${sevCounts}` : '') +
            (stats.filesSkipped ? ` · ${stats.filesSkipped} skipped` : ''),
        ),
        W,
      ),
    ),
  );
  const cost = stats.subscriptionCovered
    ? 'subscription (no API cost)'
    : stats.costUsd !== undefined
      ? `$${stats.costUsd.toFixed(4)}`
      : 'n/a';
  out.push(
    margin(
      truncate(
        pc.dim(
          `model ${stripControl(stats.model)} (${stats.provider}) · ${stats.tokensInput}→${stats.tokensOutput} tok · ${cost} · ${(stats.durationMs / 1000).toFixed(1)}s`,
        ),
        W,
      ),
    ),
  );
  out.push('');

  return out.join('\n');
}

// "3 · 1 critical · 2 minor" — total dim, each severity count colored.
function tally(findings: ReviewFinding[]): string {
  const counts = new Map<Severity, number>();
  for (const f of findings)
    counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const parts = [pc.dim(String(findings.length))];
  for (const sev of SEVERITY_ORDER) {
    const n = counts.get(sev);
    if (n) parts.push(TALLY_STYLE[sev](`${n} ${sev}`));
  }
  return parts.join(pc.dim(' · '));
}

// Render one finding: glyph + chip + title, wrapped body, a dim meta line, and a
// colored suggested-fix diff. Body hangs at column 5 (under "  ◆  ").
function renderFinding(f: ReviewFinding, sevWordW: number): string[] {
  const lines: string[] = [];
  const tone = f.severity as Tone;
  const word = f.severity.toUpperCase();
  const chipStr =
    chip(word, tone) + ' '.repeat(Math.max(0, sevWordW - word.length));
  // Title budget = canvas minus the glyph + chip gutter, so long titles
  // truncate instead of overflowing the line.
  const titleBudget = Math.max(20, W - 6 - sevWordW);
  lines.push(
    `  ${sevGlyph(tone)}  ${chipStr} ${pc.bold(truncate(clean(f.title), titleBudget))}`,
  );

  for (const l of wrapText(clean(f.description), W - 5))
    lines.push(`     ${l}`);
  if (f.rationale && f.rationale !== f.description) {
    for (const l of wrapText(clean(f.rationale), W - 5))
      lines.push(`     ${pc.dim(l)}`);
  }

  const loc =
    f.startLine === f.endLine
      ? `${clean(f.file)}:${f.startLine}`
      : `${clean(f.file)}:${f.startLine}–${f.endLine}`;
  const meta = [pc.dim(clean(f.category)), pc.cyan(loc), pc.dim(f.id)];
  if (f.confidence < 0.8) {
    meta.push(
      `${pc.dim('conf')} ${confMeter(f.confidence)} ${pc.dim(f.confidence.toFixed(2))}`,
    );
  }
  lines.push(`     ${truncate(meta.join(pc.dim(' · ')), W - 5)}`);

  if (f.suggestedPatch?.trim()) {
    const patch = clean(f.suggestedPatch.trimEnd());
    // Only +/- color a real unified diff; plain replacement code (YAML lists,
    // markdown) starts lines with `-` too and must NOT render as deletions.
    const isDiff = /^@@|^(diff |--- |\+\+\+ )/m.test(patch);
    lines.push(`     ${pc.dim('suggested fix')}`);
    for (const l of patch.split('\n')) {
      lines.push(`       ${isDiff ? diffColor(l) : pc.dim(l)}`);
    }
  }
  return lines;
}

function diffColor(line: string): string {
  const t = line.trimStart();
  if (t.startsWith('+')) return pc.green(line);
  if (t.startsWith('-')) return pc.red(line);
  if (t.startsWith('@@')) return pc.cyan(line);
  return pc.dim(line);
}
