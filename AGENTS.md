# Contributing to ergo (agent & human guide)

ergo is a local-first AI code reviewer CLI written in TypeScript on Bun. This
file captures the conventions an agent (or human) should follow when changing it.
`ergo review` also reads this file as review context.

## Layout

- `src/auth/` — Codex-subscription OAuth (PKCE + device) and credential storage.
- `src/inference/` — `ModelClient` abstraction: Codex `/responses` client and the
  ai-sdk multi-provider client; model catalog; structured-output helper.
- `src/git/` — diff collection and the unified-diff parser; repo metadata.
- `src/analysis/` — bundled static-analysis tool registry and runner.
- `src/review/` — the review engine (serialize → findings + summary → filter →
  dedupe), prompts, schema, context gathering, cache.
- `src/config/` — `.ergo.yaml` schema, loader, and glob path filters.
- `src/memory/` — learnings and usage logs.
- `src/output/` — pretty / plain / json / agent-NDJSON / SARIF / markdown renderers.
- `src/cli/` — citty command definitions.

## Conventions

- **Boring over clever.** Prefer simple, readable code. Justify any abstraction.
- **Strict TypeScript.** No `any` unless unavoidable; `noUncheckedIndexedAccess`
  is on — handle `undefined` from indexing.
- **Never log or leak secrets.** Credentials are mode `0600`; mask in any output.
- **Human output → stderr, machine output → stdout.** Keep `--format json/agent/
  sarif` clean for piping. Use `log.*` (stderr) for progress.
- **Validate untrusted input.** Config is zod-validated; CLI flags with finite
  domains (severity, confidence, format) must be validated, not silently ignored.
- **Errors are actionable.** Tell the user the next command to run.

## Workflow (run before every commit)

```bash
bun run check       # biome lint + format (this is what CI runs — no --write)
bun run typecheck
bun test
```

CI runs `biome check .` (no `--write`), so unformatted files **fail**. Run
`bun run lint:fix` to auto-fix, then `bun run check` to confirm.

## Commits

Conventional Commits (`feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`,
`perf`). No AI attribution in commit messages.

## Tests

Test behavior, not implementation. Pure logic (diff parsing, JSON extraction,
filters, cost math, patch application, arg routing) has unit tests; the review
engine is tested with a mock `ModelClient`. Add a regression test with every bug
fix.
