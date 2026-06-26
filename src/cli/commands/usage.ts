import { defineCommand } from 'citty';

import { readRateLimits } from '@/memory/ratelimits';
import { renderUsage } from '@/output/usage';

export const usageCommand = defineCommand({
  meta: {
    name: 'usage',
    description: 'Show remaining Codex subscription usage (5h / weekly limits)',
  },
  args: {
    json: { type: 'boolean', description: 'Output the snapshot as JSON' },
  },
  async run({ args }) {
    const snapshot = await readRateLimits();
    if (args.json) {
      process.stdout.write(`${JSON.stringify(snapshot ?? null, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${renderUsage(snapshot)}\n`);
  },
});
