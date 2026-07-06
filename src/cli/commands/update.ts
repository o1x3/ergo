import { defineCommand } from 'citty';

import { exec } from '@/util/exec';
import { log, pc } from '@/util/logger';
import { VERSION } from '@/version';

const REPO = 'o1x3/ergo';

async function latestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { accept: 'application/vnd.github+json' },
        // Don't hang `ergo update` forever on a stalled connection.
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name;
  } catch {
    return undefined;
  }
}

function normalize(v: string): string {
  return v.replace(/^v/, '');
}

// Compare two semver strings. Returns >0 if a>b, <0 if a<b, 0 if equal. A
// prerelease (e.g. 1.0.0-rc1) sorts before its release. Good enough for the
// release feed; unparseable parts compare as 0.
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = normalize(v).split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre && !pb.pre) return -1; // a is prerelease, b is release → a<b
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre.localeCompare(pb.pre);
  return 0;
}

export const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description: 'Update ergo to the latest release',
  },
  args: {
    check: { type: 'boolean', description: 'Only check; do not install' },
  },
  async run({ args }) {
    log.step('Checking for updates…');
    const latest = await latestVersion();
    if (!latest) {
      log.error('Could not reach the release feed. Try again later.');
      process.exitCode = 1;
      return;
    }
    const current = `v${normalize(VERSION)}`;
    const newest = `v${normalize(latest)}`;

    const cmp = compareSemver(latest, VERSION);
    if (cmp <= 0) {
      log.success(
        cmp === 0
          ? `ergo is up to date (${current}).`
          : `ergo (${current}) is newer than the latest release (${newest}).`,
      );
      return;
    }
    log.info(
      `A new version is available: ${pc.dim(current)} → ${pc.green(newest)}`,
    );
    if (args.check) {
      log.info('Run `ergo update` to install it.');
      return;
    }

    // Re-run the platform installer, which downloads + verifies the binary.
    log.step(`Installing ${newest}…`);
    if (process.platform === 'win32') {
      log.info(
        'On Windows, run:\n  irm https://raw.githubusercontent.com/o1x3/ergo/main/install.ps1 | iex',
      );
      return;
    }
    const { exitCode, stderr } = await exec(
      [
        'sh',
        '-c',
        'curl -fsSL https://raw.githubusercontent.com/o1x3/ergo/main/install.sh | sh',
      ],
      { env: { ERGO_VERSION: newest } },
    );
    if (exitCode === 0) {
      log.success(`Updated to ${newest}.`);
    } else {
      log.error(`Update failed: ${stderr.trim() || `exit ${exitCode}`}`);
      process.exitCode = 1;
    }
  },
});
