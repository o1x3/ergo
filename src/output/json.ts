import type { DiffSet } from '@/git/diff';
import { describeTarget } from '@/review/prompts';
import type { ReviewResult } from '@/review/schema';

// Single consolidated JSON document for CI / programmatic consumers.
export function renderJson(review: ReviewResult, diff: DiffSet): string {
  const doc = {
    schema: 'ergo.review/v1',
    context: {
      target: diff.target.kind,
      description: describeTarget(diff),
      base: diff.base,
      head: diff.head,
      files: diff.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        language: f.language,
      })),
    },
    summary: review.summary,
    findings: review.findings,
    stats: review.stats,
  };
  return JSON.stringify(doc, null, 2);
}
