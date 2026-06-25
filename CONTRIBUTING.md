# Contributing

Thanks for your interest in ergo! This is a short, practical guide.

## Setup

```bash
git clone https://github.com/o1x3/ergo.git
cd ergo
bun install
bun run dev -- --help
```

## Before you open a PR

Run the same checks CI runs:

```bash
bun run check       # biome lint + format (no --write — matches CI)
bun run typecheck
bun test
```

Auto-fix lint/format with `bun run lint:fix`.

## Guidelines

- Follow the conventions in [AGENTS.md](./AGENTS.md).
- Use [Conventional Commits](https://www.conventionalcommits.org/) for messages.
- Add a test for every bug fix and new behavior.
- Keep `--format json/agent/sarif` output stable — it's a public contract.
- Never commit credentials or secrets.

## Reporting bugs

Open an issue with: ergo version (`ergo --version`), OS/arch, the exact command,
and `ergo doctor` output (it redacts secrets).

## Releases (maintainers)

```bash
scripts/release.sh 0.2.0          # bumps version, runs checks, tags
git push origin main --follow-tags
```

The `Release` workflow builds cross-platform binaries (macOS binaries are ad-hoc
codesigned), publishes a GitHub release with checksums, and optionally publishes
to npm if `NPM_TOKEN` is set.
