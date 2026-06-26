import { describe, expect, test } from 'bun:test';

import type { DiffSet } from '@/git/diff';
import { parseUnifiedDiff } from '@/git/diff';
import { renderMarkdown } from '@/output/markdown';
import { renderMarkdownTerminal } from '@/output/markdown-term';
import { renderSarif } from '@/output/sarif';
import { stripAnsi } from '@/output/style';
import { renderTerminal } from '@/output/terminal';
import {
  emptySeverityCounts,
  type ReviewFinding,
  type ReviewResult,
  type SummaryResult,
} from '@/review/schema';
import { serializeDiffSet } from '@/review/serialize';

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const CSI = String.fromCharCode(0x9b);

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
  test('strips control chars from model text (preserving surrounding text)', () => {
    // Use control chars picocolors never emits, so the assertion holds whether
    // or not ANSI coloring is enabled (it differs between local TTY and CI).
    const r = review([
      finding({
        title: `evil${BELL}RED${NUL}`,
        description: `a${ESC}[2Jb${CSI}c`,
      }),
    ]);
    const out = renderTerminal(r);
    expect(out.includes(BELL)).toBe(false);
    expect(out.includes(NUL)).toBe(false);
    expect(out.includes(CSI)).toBe(false);
    expect(out).toContain('evil');
    expect(out).toContain('RED');
  });
});

describe('renderMarkdownTerminal', () => {
  // Assertions are color-mode-independent: picocolors only wraps the inner text
  // in ANSI, so the markdown *markers* are dropped whether or not color is on.
  test('strips heading markers and inline bold/code/link markers', () => {
    const out = renderMarkdownTerminal(
      '## What changed\n- Updated **DEFAULT_OAUTH_PORT** in `codex.ts`\n- See [docs](http://x)',
    );
    expect(out).not.toMatch(/^#{1,6}\s/m); // no literal `## ` heading prefix
    expect(out).not.toContain('**'); // bold markers gone
    expect(out).not.toContain('`'); // inline-code backticks gone
    expect(out).not.toContain('[docs]'); // link syntax gone
    expect(out).toContain('What changed');
    expect(out).toContain('•'); // bullets become •
    expect(out).toContain('DEFAULT_OAUTH_PORT');
    expect(out).toContain('http://x'); // link URL preserved
  });

  test('drops fence lines and keeps code content', () => {
    const out = renderMarkdownTerminal('text\n```ts\nconst x = 1;\n```');
    expect(out).not.toContain('```');
    expect(out).toContain('const x = 1;');
  });

  test('a mismatched fence char inside a block does not close it early', () => {
    // ~~~ appears inside a ```-opened block; it must be treated as code content,
    // not a closing delimiter (CommonMark: closing fence matches the open char).
    const out = renderMarkdownTerminal(
      '```\nline1\n~~~ still code\nline2\n```\nafter',
    );
    expect(out).toContain('line1');
    expect(out).toContain('~~~ still code'); // swallowed as code, not dropped
    expect(out).toContain('line2');
    expect(out).toContain('after'); // text after the real close renders normally
    expect(out).not.toContain('```');
  });

  test('does not italicize snake_case identifiers', () => {
    const out = renderMarkdownTerminal('the_value stays whole');
    expect(out).toContain('the_value');
  });
});

describe('renderTerminal walkthrough + sequence diagram', () => {
  test('strips control chars smuggled through walkthrough markdown', () => {
    // A model could embed control chars inside markdown (e.g. a heading) to try
    // to ring the bell / inject a CSI. clean() must run before render. Use only
    // control chars picocolors never emits, so this holds with color on or off
    // (pc legitimately emits ESC for its own styling).
    const r = review([], {
      walkthrough: `## pwn${BELL}heading\n- item${CSI}x${NUL}`,
    });
    const out = renderTerminal(r);
    expect(out.includes(BELL)).toBe(false);
    expect(out.includes(CSI)).toBe(false);
    expect(out.includes(NUL)).toBe(false);
    expect(out).toContain('pwn'); // surrounding text survives
  });

  test('pretty mode renders walkthrough markdown into terminal styling', () => {
    const r = review([], { walkthrough: '## Why\n- it **matters**' });
    // Strip ANSI so the assertions hold whether or not color is on — with color
    // the bold around "matters" would otherwise split the "it matters" run.
    const out = stripAnsi(renderTerminal(r));
    expect(out).toContain('•'); // walkthrough bullet rendered
    expect(out).toContain('it matters'); // text preserved
    expect(out).not.toContain('**'); // bold markers stripped
    expect(out).not.toMatch(/^#{1,6}\s/m); // heading markers stripped
  });

  test('renders the sequence diagram as a mermaid block in both modes', () => {
    const r = review([], {
      sequenceDiagram: 'sequenceDiagram\n  participant User',
    });
    for (const raw of [renderTerminal(r), renderTerminal(r, { plain: true })]) {
      const out = stripAnsi(raw);
      expect(out).toContain('Sequence diagram');
      expect(out).toContain('```mermaid');
      expect(out).toContain('participant User');
    }
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
