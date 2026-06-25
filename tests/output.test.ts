import { describe, expect, test } from 'bun:test';

import type { DiffSet } from '@/git/diff';
import { parseUnifiedDiff } from '@/git/diff';
import { renderMarkdown } from '@/output/markdown';
import { renderSarif } from '@/output/sarif';
import { renderTerminal } from '@/output/terminal';
import {
  emptySeverityCounts,
  type ReviewFinding,
  type ReviewResult,
  type SummaryResult,
} from '@/review/schema';
import { serializeDiffSet } from '@/review/serialize';

const ESC = String.fromCharCode(27);

function finding(p: Partial<ReviewFinding>): ReviewFinding {
  return {
    id: 'ERG-1',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    severity: 'major',
    category: 'correctness',
    title: 'title',
    description: 'desc',
    rationale: 'why',
    confidence: 0.9,
    codegenInstructions: 'fix it',
    ...p,
  };
}

function review(
  findings: ReviewFinding[],
  summary?: Partial<SummaryResult>,
): ReviewResult {
  return {
    summary: {
      summary: 'sum',
      walkthrough: '',
      fileSummaries: [],
      effort: 2,
      mergeConfidence: 3,
      sequenceDiagram: undefined,
      ...summary,
    },
    findings,
    stats: {
      filesReviewed: 1,
      filesSkipped: 0,
      additions: 1,
      deletions: 0,
      findingsBySeverity: emptySeverityCounts(),
      tokensInput: 0,
      tokensOutput: 0,
      subscriptionCovered: false,
      model: 'gpt-5.4',
      provider: 'openai',
      durationMs: 0,
    },
  };
}

function fakeDiff(): DiffSet {
  return {
    files: [],
    target: { kind: 'working' },
    head: 'HEAD',
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

describe('renderTerminal sanitization', () => {
  test('strips ANSI/control sequences from model text', () => {
    const r = review([
      finding({
        title: `evil${ESC}[31mRED${ESC}[0m`,
        description: `a${ESC}[2Jb`,
      }),
    ]);
    const out = renderTerminal(r);
    expect(out.includes(ESC)).toBe(false); // raw ESC removed
    expect(out).toContain('evil');
    expect(out).toContain('RED');
  });
});

describe('renderSarif clamping', () => {
  test('clamps startLine to >= 1 and endLine >= startLine', () => {
    const r = review([finding({ startLine: 0, endLine: 0 })]);
    const sarif = JSON.parse(renderSarif(r));
    const region =
      sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(1);
    expect(region.endLine).toBeGreaterThanOrEqual(region.startLine);
  });
});

describe('renderMarkdown escaping', () => {
  test('escapes pipes/newlines in table cells', () => {
    const r = review([], {
      fileSummaries: [{ path: 'a|b.ts', summary: 'line1\nline2 | pipe' }],
    });
    const md = renderMarkdown(r, fakeDiff());
    const tableLine = md.split('\n').find((l) => l.includes('a\\|b.ts'));
    expect(tableLine).toBeDefined();
    expect(tableLine).not.toContain('line1\nline2');
  });

  test('uses a longer fence when patch contains a triple backtick', () => {
    const r = review([
      finding({ suggestedPatch: 'before\n```\ninside\n```\nafter' }),
    ]);
    const md = renderMarkdown(r, fakeDiff());
    expect(md).toContain('````'); // 4-backtick fence
  });
});

describe('serializeDiffSet budget', () => {
  test('truncates a single oversized file to respect maxChars', () => {
    const big = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,1 +1,1000 @@
${Array.from({ length: 1000 }, (_, i) => `+const x${i} = ${i};`).join('\n')}
`;
    const files = parseUnifiedDiff(big);
    const ds: DiffSet = {
      files,
      target: { kind: 'working' },
      head: 'HEAD',
      totalAdditions: 1000,
      totalDeletions: 0,
    };
    const { text } = serializeDiffSet(ds, { maxChars: 5_000 });
    expect(text.length).toBeLessThan(5_200);
    expect(text).toContain('[diff truncated');
  });
});
