import { describe, expect, test } from 'bun:test';

import type { DiffSet } from '@/git/diff';
import { parseUnifiedDiff } from '@/git/diff';
import type { ResolvedClient } from '@/inference/resolve';
import type {
  CompletionRequest,
  CompletionResult,
  ModelClient,
} from '@/inference/types';
import { runReview } from '@/review/engine';
import type { PromptContext } from '@/review/prompts';

const SAMPLE_DIFF = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,4 +1,6 @@
 export function handler(req) {
-  return db.query("SELECT * FROM t");
+  const id = req.query.id;
+  return db.query("SELECT * FROM t WHERE id = " + id);
+  // TODO: validate id
 }
`;

function diffSet(): DiffSet {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  return {
    files,
    target: { kind: 'working' },
    head: 'HEAD',
    totalAdditions: files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

// A mock model client that returns canned structured output. Detects which pass
// is being requested by inspecting the JSON schema shape.
function mockClient(findings: unknown[]): ModelClient {
  return {
    provider: 'openai',
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const props = (req.jsonSchema?.properties ?? {}) as Record<
        string,
        unknown
      >;
      if ('findings' in props) {
        return {
          text: JSON.stringify({ findings }),
          finishReason: 'stop',
          usage: { input: 100, output: 50 },
        };
      }
      return {
        text: JSON.stringify({
          summary: 'Adds id param to query.',
          walkthrough: '## Changes\nAdded id.',
          fileSummaries: [{ path: 'src/api.ts', summary: 'SQL change' }],
          effort: 2,
          mergeConfidence: 2,
          sequenceDiagram: '',
        }),
        finishReason: 'stop',
        usage: { input: 80, output: 40 },
      };
    },
  };
}

function resolved(client: ModelClient): ResolvedClient {
  return {
    client,
    model: 'gpt-5.4',
    provider: 'openai',
    subscription: false,
  };
}

const promptContext: PromptContext = {
  profile: 'assertive',
  minConfidence: 0.6,
};

describe('runReview', () => {
  test('produces findings, assigns ids, computes stats', async () => {
    const client = mockClient([
      {
        file: 'src/api.ts',
        startLine: 3,
        endLine: 3,
        severity: 'critical',
        category: 'security',
        title: 'SQL injection via string concatenation',
        description: 'User input is concatenated into a SQL query.',
        rationale: 'Allows arbitrary SQL execution.',
        confidence: 0.95,
        codegenInstructions: 'Use a parameterized query.',
        suggestedPatch:
          '  return db.query("SELECT * FROM t WHERE id = ?", [id]);',
      },
    ]);

    const review = await runReview({
      diff: diffSet(),
      resolved: resolved(client),
      promptContext,
    });

    expect(review.findings.length).toBe(1);
    expect(review.findings[0]!.id).toBe('ERG-1');
    expect(review.findings[0]!.severity).toBe('critical');
    expect(review.stats.findingsBySeverity.critical).toBe(1);
    expect(review.stats.filesReviewed).toBe(1);
    expect(review.stats.tokensInput).toBeGreaterThan(0);
    expect(review.summary.summary).toContain('id');
  });

  test('filters findings below the confidence threshold', async () => {
    const client = mockClient([
      {
        file: 'src/api.ts',
        startLine: 4,
        endLine: 4,
        severity: 'minor',
        category: 'maintainability',
        title: 'Leftover TODO',
        description: 'TODO comment.',
        rationale: 'noise',
        confidence: 0.3,
        codegenInstructions: 'Remove TODO.',
      },
    ]);
    const review = await runReview({
      diff: diffSet(),
      resolved: resolved(client),
      promptContext: { ...promptContext, minConfidence: 0.6 },
    });
    expect(review.findings.length).toBe(0);
  });

  test('drops findings referencing files not in the diff', async () => {
    const client = mockClient([
      {
        file: 'other/file.ts',
        startLine: 1,
        endLine: 1,
        severity: 'major',
        category: 'correctness',
        title: 'Phantom finding',
        description: 'Not in diff.',
        rationale: 'hallucination',
        confidence: 0.99,
        codegenInstructions: 'n/a',
      },
    ]);
    const review = await runReview({
      diff: diffSet(),
      resolved: resolved(client),
      promptContext,
    });
    expect(review.findings.length).toBe(0);
  });

  test('clamps out-of-range line numbers to file bounds', async () => {
    const client = mockClient([
      {
        file: 'src/api.ts',
        startLine: 9999,
        endLine: 10000,
        severity: 'major',
        category: 'correctness',
        title: 'Range overflow',
        description: 'bad lines',
        rationale: 'x',
        confidence: 0.9,
        codegenInstructions: 'n/a',
      },
    ]);
    const review = await runReview({
      diff: diffSet(),
      resolved: resolved(client),
      promptContext,
    });
    expect(review.findings.length).toBe(1);
    expect(review.findings[0]!.startLine).toBeLessThanOrEqual(
      review.findings[0]!.endLine,
    );
    expect(review.findings[0]!.endLine).toBeLessThan(9999);
  });

  test('emits streaming events', async () => {
    const client = mockClient([]);
    const phases: string[] = [];
    await runReview({
      diff: diffSet(),
      resolved: resolved(client),
      promptContext,
      onEvent: (e) => {
        if (e.type === 'status') phases.push(e.phase);
      },
    });
    expect(phases).toContain('reviewing');
    expect(phases).toContain('completed');
  });
});
