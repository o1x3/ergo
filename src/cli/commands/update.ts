import { defineCommand } from 'citty';

import { exec } from '@/util/exec';
import { log, pc } from '@/util/logger';
import { VERSION } from '@/version';

const REPO = 'o1x3/ergo';

async function latestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { accept: 'application/vnd.github+json' } },
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

    if (normalize(latest) === normalize(VERSION)) {
      log.success(`ergo is up to date (${current}).`);
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
