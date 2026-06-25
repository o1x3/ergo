import type { ReviewResult, Severity } from '@/review/schema';
import { pc } from '@/util/logger';

const SEVERITY_LABEL: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bgRed(pc.white(` ${s} `)),
  major: (s) => pc.red(pc.bold(s)),
  minor: (s) => pc.yellow(s),
  suggestion: (s) => pc.blue(s),
  info: (s) => pc.dim(s),
};

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '⛔',
  major: '🔴',
  minor: '🟡',
  suggestion: '🔵',
  info: '⚪',
};

function severityTag(sev: Severity): string {
  return SEVERITY_LABEL[sev](sev.toUpperCase());
}

// Strip terminal control/escape sequences from model-supplied text so a crafted
// diff/finding can't move the cursor, recolor, or inject escapes into the user's
// terminal. Keeps tab (0x09) and newline (0x0a). Codepoint-based to avoid any
// control characters appearing in source.
function clean(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl =
      (c < 0x20 && c !== 0x09 && c !== 0x0a) ||
      c === 0x7f ||
      (c >= 0x80 && c <= 0x9f);
    if (!isControl) out += ch;
  }
  return out;
}

function bar(): string {
  return pc.dim('─'.repeat(60));
}

// Render a full review for humans. `plain` drops emoji and keeps it pipe-friendly.
export function renderTerminal(
  review: ReviewResult,
  options: { plain?: boolean } = {},
): string {
  const out: string[] = [];
  const { summary, findings, stats } = review;

  // Header
  out.push('');
  out.push(pc.bold(pc.cyan('  ergo review')));
  out.push(bar());

  // Summary
  if (summary.summary) {
    out.push('');
    out.push(pc.bold('Summary'));
    out.push(clean(summary.summary));
  }

  if (summary.fileSummaries.length > 0) {
    out.push('');
    out.push(pc.bold('Changed files'));
    for (const f of summary.fileSummaries) {
      out.push(`  ${pc.cyan(clean(f.path))} — ${clean(f.summary)}`);
    }
  }

  if (summary.walkthrough && !options.plain) {
    out.push('');
    out.push(pc.bold('Walkthrough'));
    out.push(clean(summary.walkthrough));
  }

  if (summary.sequenceDiagram?.trim()) {
    out.push('');
    out.push(pc.bold('Sequence diagram'));
    out.push('```mermaid');
    out.push(clean(summary.sequenceDiagram.trim()));
    out.push('```');
  }

  // Findings
  out.push('');
  out.push(bar());
  if (findings.length === 0) {
    out.push(pc.green('✓ No issues found.'));
  } else {
    out.push(
      pc.bold(`${findings.length} finding${findings.length === 1 ? '' : 's'}`),
    );
    for (const f of findings) {
      out.push('');
      const icon = options.plain ? '' : `${SEVERITY_ICON[f.severity]} `;
      out.push(
        `${icon}${severityTag(f.severity)} ${pc.dim(`[${clean(f.category)}]`)} ${pc.bold(clean(f.title))} ${pc.dim(`(${f.id}, conf ${f.confidence.toFixed(2)})`)}`,
      );
      const loc =
        f.startLine === f.endLine
          ? `${clean(f.file)}:${f.startLine}`
          : `${clean(f.file)}:${f.startLine}-${f.endLine}`;
      out.push(`  ${pc.underline(loc)}`);
      out.push(indent(clean(f.description), '  '));
      if (f.rationale && f.rationale !== f.description) {
        out.push(indent(pc.dim(clean(f.rationale)), '  '));
      }
      if (f.suggestedPatch?.trim()) {
        out.push(`  ${pc.dim('suggested fix:')}`);
        out.push('  ```');
        out.push(indent(clean(f.suggestedPatch.trimEnd()), '  '));
        out.push('  ```');
      }
    }
  }

  // Footer / stats
  out.push('');
  out.push(bar());
  const sevCounts = Object.entries(stats.findingsBySeverity)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
  out.push(
    pc.dim(
      `${stats.filesReviewed} file(s) reviewed · +${stats.additions}/-${stats.deletions}` +
        (sevCounts ? ` · ${sevCounts}` : '') +
        (stats.filesSkipped ? ` · ${stats.filesSkipped} skipped` : ''),
    ),
  );
  const cost = stats.subscriptionCovered
    ? 'subscription (no API cost)'
    : stats.costUsd !== undefined
      ? `$${stats.costUsd.toFixed(4)}`
      : 'n/a';
  out.push(
    pc.dim(
      `model ${stats.model} (${stats.provider}) · ${stats.tokensInput}→${stats.tokensOutput} tok · ${cost} · ${(stats.durationMs / 1000).toFixed(1)}s`,
    ),
  );
  out.push('');

  return out.join('\n');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
