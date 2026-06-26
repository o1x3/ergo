import { defineCommand } from 'citty';

import { computeDashboard, parseStatsWindow } from '@/memory/stats';
import { readUsage } from '@/memory/usage';
import { renderDashboard } from '@/output/dashboard';
import { log } from '@/util/logger';

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description:
      'Local review dashboard: counts, streaks, tokens (e.g. ergo stats 7d)',
  },
  args: {
    window: {
      type: 'positional',
      required: false,
      description:
        'Time window: all | 7d | 30d | 1m | N followed by d/w/m (default: all)',
    },
    json: { type: 'boolean', description: 'Output the dashboard as JSON' },
  },
  async run({ args }) {
    const window = parseStatsWindow(args.window as string | undefined);
    if (window === null) {
      log.error(
        `Invalid window '${args.window}'. Use all, 7d, 30d, 1m, or N followed by d/w/m.`,
      );
      process.exitCode = 1;
      return;
    }
    const records = await readUsage();
    const dash = computeDashboard(records, window);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(dash, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${renderDashboard(dash)}\n`);
  },
});
