<div align="center">

# ⚡ ergo

**A fast, local-first AI code reviewer for your terminal.**

Bring your own ChatGPT/Codex subscription or API key. Review uncommitted changes,
branches, and pull requests with the depth of CodeRabbit and the precision of
cubic — without the per-seat SaaS bill.

[![CI](https://github.com/o1x3/ergo/actions/workflows/ci.yml/badge.svg)](https://github.com/o1x3/ergo/actions/workflows/ci.yml)
[![Release](https://github.com/o1x3/ergo/actions/workflows/release.yml/badge.svg)](https://github.com/o1x3/ergo/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

> **Status:** under active development. The inference layer (Codex-subscription
> OAuth + multi-provider) and authentication are in place; the review engine,
> config, and distribution are landing rapidly. See [the roadmap](#roadmap).

## Why ergo?

- **Bring your own inference.** Connect your existing ChatGPT Plus/Pro/Team
  subscription via OAuth — reviews run on your plan with **zero incremental API
  billing**. Or plug in an OpenAI / Anthropic / OpenAI-compatible (Ollama,
  OpenRouter, vLLM) API key.
- **Local-first.** Reviews run against your local git state — uncommitted,
  staged, a branch, or a range. No need to push to get feedback.
- **Cheaper than the alternatives.** No per-seat pricing. You pay for inference
  (or nothing, on a subscription).
- **Scriptable.** Plain, JSON, markdown, and prompt-only output for piping into
  other tools and agents. Sensible exit codes for CI gating.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/o1x3/ergo/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/o1x3/ergo/main/install.ps1 | iex
```

> Cross-platform single-file binaries (macOS arm64/x64, Linux arm64/x64,
> Windows x64) are published on every [release](https://github.com/o1x3/ergo/releases).

## Quick start

```bash
# 1. Connect your ChatGPT/Codex subscription (opens your browser)
ergo auth login

# …or use an API key
ergo auth login --api-key --provider anthropic

# 2. Review your uncommitted changes
ergo review

# 3. Review a branch against main
ergo review --base main
```

## Authentication

| Command | What it does |
| --- | --- |
| `ergo auth login` | Browser OAuth to your ChatGPT/Codex subscription (PKCE) |
| `ergo auth login --device` | Device-code flow for headless / remote machines |
| `ergo auth login --api-key --provider openai` | Store an API key |
| `ergo auth status` | Show the active credential (secrets masked) |
| `ergo auth logout` | Remove the stored credential |

Credentials live in `~/.ergo/auth.json` (mode `0600`). Environment variables
(`ERGO_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) override stored
credentials so CI can run unattended.

## Roadmap

- [x] Codex-subscription OAuth (PKCE + device flow) & multi-provider inference
- [ ] Review engine: summary/walkthrough + line-level findings with severities
- [ ] `.ergo.yaml` configuration (path filters, instructions, profiles)
- [ ] Bundled static-analysis grounding (ruff, eslint, semgrep, gitleaks, …)
- [ ] Learnings/memory from past reviews
- [ ] Interactive chat about a diff
- [ ] PR review (GitHub) & inline comments
- [ ] Cross-platform binaries, `install.sh` / `install.ps1`, CI/CD & releases

## Development

```bash
bun install
bun run dev -- --help     # run the CLI from source
bun test                  # run the test suite
bun run typecheck         # type-check
bun run check             # lint + format check (biome)
```

## License

[MIT](./LICENSE) © Karthik Vinayan / o1x3
