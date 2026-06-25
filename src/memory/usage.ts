import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ReviewStats } from '@/review/schema';
import { ergoHome } from '@/util/paths';

// Append-only usage log so `ergo stats` can report local review counts, tokens,
// and $ cost over time. One JSON object per line; never contains code or secrets.
export interface UsageRecord {
  ts: string;
  repo: string;
  model: string;
  provider: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  findings: number;
  subscription: boolean;
}

function usagePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(ergoHome(env), 'usage.jsonl');
}

export async function recordUsage(
  repo: string,
  stats: ReviewStats,
): Promise<void> {
  const findings = Object.values(stats.findingsBySeverity).reduce(
    (a, b) => a + b,
    0,
  );
  const record: UsageRecord = {
    ts: new Date().toISOString(),
    repo,
    model: stats.model,
    provider: stats.provider,
    tokensInput: stats.tokensInput,
    tokensOutput: stats.tokensOutput,
    costUsd: stats.costUsd ?? 0,
    findings,
    subscription: stats.subscriptionCovered,
  };
  const path = usagePath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readUsage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageRecord[]> {
  try {
    const raw = await readFile(usagePath(env), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as UsageRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is UsageRecord => r !== undefined);
  } catch {
    return [];
  }
}

export interface UsageSummary {
  reviews: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  findings: number;
  byModel: Record<string, { reviews: number; costUsd: number }>;
  subscriptionReviews: number;
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const summary: UsageSummary = {
    reviews: records.length,
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    findings: 0,
    byModel: {},
    subscriptionReviews: 0,
  };
  for (const r of records) {
    summary.tokensInput += r.tokensInput;
    summary.tokensOutput += r.tokensOutput;
    summary.costUsd += r.costUsd;
    summary.findings += r.findings;
    if (r.subscription) summary.subscriptionReviews += 1;
    const m = (summary.byModel[r.model] ??= { reviews: 0, costUsd: 0 });
    m.reviews += 1;
    m.costUsd += r.costUsd;
  }
  return summary;
}
