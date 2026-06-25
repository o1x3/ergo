import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import { loadConfig } from '@/config/load';
import { isGitRepo, repoRoot } from '@/git/repo';
import { log, pc } from '@/util/logger';
import { confirm } from '@/util/prompt';

const STARTER_CONFIG = `# yaml-language-server: $schema=https://raw.githubusercontent.com/o1x3/ergo/main/schema.json
version: 1

# Output language and reviewer tone.
language: en-US
# tone_instructions: "Be concise and direct."

model:
  # provider is normally inferred from your credential (ergo auth login).
  # provider: codex            # codex | openai | anthropic | openai-compatible
  # default: gpt-5.4           # model for normal reviews
  # triage: gpt-5.4-mini       # cheaper model for --light
  # deep: gpt-5.4              # strongest model for --deep
  max_budget_usd: 0            # 0 = unlimited

reviews:
  profile: chill               # chill | assertive
  min_confidence: 0.6          # drop findings below this confidence (0-1)
  sequence_diagrams: true
  path_filters:
    - "!**/*.lock"
    - "!dist/**"
    - "!**/*.min.js"
  path_instructions:
    - path: "src/**/*.ts"
      instructions: "Enforce strict null handling and avoid 'any'."
  # custom_agents:
  #   - name: no-raw-sql
  #     instructions: "Flag string-concatenated SQL; require parameterized queries."
  #     include: ["**/*.ts"]
  tools:
    eslint: { enabled: true }
    ruff: { enabled: true }
    semgrep: { enabled: true }
    gitleaks: { enabled: true }

knowledge_base:
  learnings:
    scope: auto                # local | global | auto

output:
  default_format: pretty       # pretty | plain | json | agent | sarif | markdown
  color: auto
`;

const initCommand = defineCommand({
  meta: { name: 'init', description: 'Write a starter .ergo.yaml' },
  args: {
    force: { type: 'boolean', description: 'Overwrite an existing config' },
  },
  async run({ args }) {
    const root = (await isGitRepo()) ? await repoRoot() : process.cwd();
    const path = join(root, '.ergo.yaml');
    let exists = false;
    try {
      await access(path);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !args.force) {
      const ok = await confirm(`${path} exists. Overwrite?`, false);
      if (!ok) {
        log.info('Aborted.');
        return;
      }
    }
    await writeFile(path, STARTER_CONFIG, 'utf8');
    log.success(`Wrote ${pc.cyan(path)}`);
  },
});

const showCommand = defineCommand({
  meta: { name: 'show', description: 'Print the resolved configuration' },
  async run() {
    const root = (await isGitRepo()) ? await repoRoot() : process.cwd();
    const { config, sources, errors } = await loadConfig(root);
    if (sources.length > 0) log.info(`sources: ${sources.join(', ')}`);
    else log.info('sources: (defaults only)');
    for (const e of errors) log.warn(e);
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  },
});

const validateCommand = defineCommand({
  meta: { name: 'validate', description: 'Validate .ergo.yaml' },
  async run() {
    const root = (await isGitRepo()) ? await repoRoot() : process.cwd();
    const { sources, errors } = await loadConfig(root);
    if (errors.length === 0) {
      log.success(
        sources.length > 0
          ? `Valid (${sources.join(', ')}).`
          : 'No config found; defaults are valid.',
      );
    } else {
      for (const e of errors) log.error(e);
      process.exitCode = 1;
    }
  },
});

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Manage ergo configuration' },
  subCommands: {
    init: initCommand,
    show: showCommand,
    validate: validateCommand,
  },
});
