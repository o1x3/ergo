import { defineCommand } from 'citty';

import { readUsage, summarizeUsage } from '@/memory/usage';
import { log, pc } from '@/util/logger';

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Show local review usage: counts, tokens, and cost',
  },
  args: {
    json: { type: 'boolean', description: 'Output JSON' },
  },
  async run({ args }) {
    const records = await readUsage();
    const summary = summarizeUsage(records);

    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }

    if (summary.reviews === 0) {
      log.info('No reviews recorded yet. Run `ergo review` to get started.');
      return;
    }

    log.info(pc.bold('ergo usage'));
    log.raw(`  reviews:        ${summary.reviews}`);
    log.raw(`  findings:       ${summary.findings}`);
    log.raw(
      `  tokens:         ${summary.tokensInput.toLocaleString()} in → ${summary.tokensOutput.toLocaleString()} out`,
    );
    log.raw(
      `  API cost:       $${summary.costUsd.toFixed(4)} (${summary.subscriptionReviews}/${summary.reviews} on subscription, $0)`,
    );
    log.info('');
    log.info(pc.bold('by model'));
    for (const [model, m] of Object.entries(summary.byModel)) {
      log.raw(
        `  ${model.padEnd(26)} ${m.reviews} review(s)  $${m.costUsd.toFixed(4)}`,
      );
    }
  },
});
