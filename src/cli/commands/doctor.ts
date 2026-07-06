import { defineCommand } from 'citty';

import { ALL_TOOLS } from '@/analysis/tools';
import { loadCredential, resolveCredentialFromEnv } from '@/auth/storage';
import { loadConfig } from '@/config/load';
import { isGitRepo, repoRoot } from '@/git/repo';
import { commandExists } from '@/util/exec';
import { log, pc } from '@/util/logger';
import { authFilePath } from '@/util/paths';
import { VERSION } from '@/version';

type Check = { ok: boolean; warn?: boolean; label: string; detail: string };

function mark(c: Check): string {
  const icon = c.ok ? pc.green('✓') : c.warn ? pc.yellow('!') : pc.red('✗');
  return `${icon} ${c.label} ${pc.dim(c.detail)}`;
}

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Diagnose your ergo setup (auth, git, tools, config)',
  },
  async run() {
    const checks: Check[] = [];
    let hardFail = false;

    checks.push({
      ok: true,
      label: 'ergo',
      detail: `v${VERSION} · bun ${Bun.version} · ${process.platform}/${process.arch}`,
    });

    // git
    const gitOk = await commandExists('git');
    checks.push({
      ok: gitOk,
      label: 'git',
      detail: gitOk ? 'installed' : 'NOT installed',
    });
    if (!gitOk) hardFail = true;

    const inRepo = gitOk && (await isGitRepo());
    checks.push({
      ok: inRepo,
      warn: !inRepo,
      label: 'repository',
      detail: inRepo ? await repoRoot() : 'not inside a git repo (cd into one)',
    });

    // auth
    let envCred: ReturnType<typeof resolveCredentialFromEnv>;
    try {
      envCred = resolveCredentialFromEnv();
    } catch (err) {
      checks.push({
        ok: false,
        label: 'auth',
        detail: err instanceof Error ? err.message : String(err),
      });
      hardFail = true;
    }
    const stored = await loadCredential(authFilePath());
    const cred = envCred ?? stored;
    if (cred) {
      let detail = `${cred.provider} (${cred.type})`;
      if (cred.type === 'oauth' && cred.expiresAt) {
        const ms = Date.parse(cred.expiresAt) - Date.now();
        detail +=
          ms > 0
            ? ` · token valid ~${Math.round(ms / 60000)}m`
            : ' · token expired (will refresh)';
      }
      if (envCred) detail += ' · from env';
      checks.push({ ok: true, label: 'auth', detail });
    } else {
      checks.push({
        ok: false,
        label: 'auth',
        detail: 'no credential — run `ergo auth login`',
      });
      hardFail = true;
    }

    // config
    if (inRepo) {
      const root = await repoRoot();
      const { config, sources, errors } = await loadConfig(root);
      checks.push({
        ok: errors.length === 0,
        warn: errors.length > 0,
        label: 'config',
        detail:
          sources.length > 0
            ? `${sources.length} source(s) · profile=${config.reviews.profile}`
            : 'using defaults (no .ergo.yaml)',
      });
      for (const e of errors)
        checks.push({ ok: false, warn: true, label: 'config', detail: e });
    }

    // static-analysis tools
    const present: string[] = [];
    const missing: string[] = [];
    await Promise.all(
      ALL_TOOLS.map(async (t) => {
        if (await commandExists(t.bin)) present.push(t.name);
        else missing.push(t.name);
      }),
    );
    checks.push({
      ok: true,
      warn: present.length === 0,
      label: 'static analysis',
      detail:
        present.length > 0
          ? `${present.length} available: ${present.sort().join(', ')}`
          : 'none installed (reviews still work; install linters for grounding)',
    });
    if (missing.length > 0) {
      checks.push({
        ok: true,
        warn: true,
        label: 'tools (optional)',
        detail: `not found: ${missing.sort().join(', ')}`,
      });
    }

    for (const c of checks) log.raw(mark(c));
    log.info('');
    if (hardFail) {
      log.error('Some required checks failed.');
      process.exitCode = 1;
    } else {
      log.success('ergo is ready.');
    }
  },
});
