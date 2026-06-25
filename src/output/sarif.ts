import type { ReviewResult, Severity } from '@/review/schema';
import { VERSION } from '@/version';

// SARIF 2.1.0 output for GitHub code-scanning and SARIF-aware IDEs. Neither
// CodeRabbit's nor cubic's CLI emits SARIF — this is a beyond-parity feature.

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  major: 'error',
  minor: 'warning',
  suggestion: 'note',
  info: 'note',
};

export function renderSarif(review: ReviewResult): string {
  const ruleIds = new Map<string, { category: string }>();
  for (const f of review.findings) {
    const ruleId = `ergo/${f.category}`;
    if (!ruleIds.has(ruleId)) ruleIds.set(ruleId, { category: f.category });
  }

  const rules = [...ruleIds.entries()].map(([id, meta]) => ({
    id,
    name: meta.category,
    shortDescription: { text: `ergo ${meta.category} finding` },
    defaultConfiguration: { level: 'warning' as const },
  }));

  const results = review.findings.map((f) => ({
    ruleId: `ergo/${f.category}`,
    level: LEVEL[f.severity],
    message: {
      text: `${f.title}\n\n${f.description}${f.rationale ? `\n\n${f.rationale}` : ''}`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: {
            startLine: f.startLine,
            endLine: f.endLine,
          },
        },
      },
    ],
    properties: {
      severity: f.severity,
      confidence: f.confidence,
      id: f.id,
    },
  }));

  const sarif = {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ergo',
            informationUri: 'https://github.com/o1x3/ergo',
            version: VERSION,
            rules,
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
