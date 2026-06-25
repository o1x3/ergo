<div align="center">

# ⚡ ergo

**A fast, local-first AI code reviewer for your terminal.**

Bring your own ChatGPT/Codex subscription or API key. Review uncommitted changes,
branches, and commits with the depth of CodeRabbit and the precision of cubic —
without the per-seat SaaS bill, line caps, or a cloud relay touching your code.

[![CI](https://github.com/o1x3/ergo/actions/workflows/ci.yml/badge.svg)](https://github.com/o1x3/ergo/actions/workflows/ci.yml)
[![Release](https://github.com/o1x3/ergo/actions/workflows/release.yml/badge.svg)](https://github.com/o1x3/ergo/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Made with Bun](https://img.shields.io/badge/Bun-1.2+-black?logo=bun)](https://bun.sh)

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Config](#configuration) · [vs CodeRabbit & cubic](#how-ergo-compares)

</div>

---

## Why ergo?

Most AI review tools are SaaS: you push code to their cloud, pay per seat, and
hit line/file/hour caps. **ergo runs entirely on your machine** and drives *your*
model — so it's private, uncapped, and effectively free if you already pay for
ChatGPT.

- 🔑 **Bring your own inference.** Connect your existing **ChatGPT Plus/Pro/Team
  subscription** over OAuth — reviews run on your plan with **zero incremental API
  billing**. Or use an **OpenAI / Anthropic / OpenAI-compatible** (Ollama,
  OpenRouter, vLLM) API key.
- 🏠 **Local-first.** Reviews run against your local git state. Your code never
  leaves the machine except as the model API calls you already make.
- 💸 **No caps, no seats.** No per-seat fee, no lines-per-month cap, no per-file
  metering. The only limit is your own model quota.
- 🧪 **Grounded in real tools.** Runs your installed linters/SAST (ruff, eslint,
  semgrep, shellcheck, gitleaks, hadolint, mypy…) on the diff and feeds their
  findings to the model to verify, dedupe, and prioritize — fewer false positives.
- 🤖 **Scriptable.** Pretty TUI, plain text, JSON, **CodeRabbit-compatible NDJSON
  `--agent` stream**, **SARIF** for GitHub code scanning, and markdown reports.
- 📈 **Cost-transparent.** Every review prints tokens used and the exact $ cost
  (or "subscription — no API cost").

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/o1x3/ergo/main/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/o1x3/ergo/main/install.ps1 | iex
```

### From npm (any platform with Bun/Node)

```bash
bun add -g @o1x3/ergo      # or: npm i -g @o1x3/ergo
```

Single-file binaries for **macOS (arm64/x64)**, **Linux (arm64/x64)**, and
**Windows (x64)** are attached to every [release](https://github.com/o1x3/ergo/releases),
checksummed in `SHA256SUMS.txt`. The installer verifies the checksum automatically.

> Installer env vars: `ERGO_VERSION` (pin a version), `ERGO_INSTALL_DIR`
> (target dir), `ERGO_DOWNLOAD_URL` (mirror).

## Quick start

```bash
# 1. Connect your ChatGPT/Codex subscription (opens your browser)
ergo auth login

#    …already use the Codex CLI? Import its credential:
ergo auth import

#    …or use an API key:
ergo auth login --api-key --provider anthropic

# 2. Review your uncommitted changes
ergo review            # bare `ergo` works too

# 3. Review a branch against main
ergo review --base main

# 4. Gate CI on it
ergo review --base origin/main --format json --fail-on major
```

## Commands

| Command | Description |
| --- | --- |
| `ergo review` | Review local changes (the default command — bare `ergo` runs it) |
| `ergo review findings` | Replay the last review from cache (no re-run, no cost) |
| `ergo fix [--id … / --all]` | Apply suggested fixes from the last review to the working tree |
| `ergo describe` | Generate a PR/commit title + description from the diff |
| `ergo chat` | Interactively ask questions about your changes |
| `ergo auth login` | Connect a ChatGPT/Codex subscription or API key |
| `ergo auth import` | Import an existing Codex CLI credential (`~/.codex/auth.json`) |
| `ergo auth status` / `logout` | Show / remove the active credential |
| `ergo doctor` | Diagnose auth, git, config, and installed analysis tools |
| `ergo config init` / `show` / `validate` | Manage `.ergo.yaml` |
| `ergo learn add` / `list` / `rm` | Teach ergo durable review preferences |
| `ergo learn mine` | Mine the repo's review conventions from git history + guidelines |
| `ergo models` | List available models and pricing |
| `ergo stats` | Local usage: reviews, tokens, and cost |
| `ergo update` | Self-update to the latest release |
| `ergo install-hook [--uninstall]` | Install a pre-push/pre-commit review gate |
| `ergo mcp` | Run as an MCP server (review tools for Claude Code / Cursor) |

### `ergo review` options

| Flag | Description |
| --- | --- |
| `-t, --type <scope>` | `all` · `committed` · `uncommitted` · `staged` |
| `--base <branch>` | Review the current branch against a base (e.g. `main`) |
| `--base-commit <sha>` | Compare against a specific commit |
| `-c, --commit <ref>` | Review a single commit (e.g. `HEAD~1`) |
| `--dir <path>` | Review a different repo directory |
| `-f, --files <a,b>` | Review only specific files |
| `-p, --prompt <text>` | Extra focus (e.g. `"check for SQL injection"`) |
| `--instructions <files>` | Layer extra instruction files onto the review |
| `--format <fmt>` | `pretty` · `plain` · `json` · `agent` · `sarif` · `markdown` |
| `-m, --model <id>` | Override the model |
| `--profile <p>` | `chill` (fewer nits) · `assertive` (thorough) |
| `--light` / `--deep` | Cheaper/faster triage model · strongest model + higher effort |
| `--min-confidence <0-1>` | Drop findings below this confidence |
| `--fail-on <severity>` | Exit non-zero if any finding ≥ severity (CI gating) |
| `--budget <usd>` | Abort before running if the estimated API cost would exceed this |
| `--no-static` | Skip static-analysis grounding |
| `-q, --quiet` | Suppress progress output |

### Output formats

- **`pretty`** (default) — colorized terminal report with summary, walkthrough,
  Mermaid diagram, and per-finding details.
- **`plain`** — pipe-friendly text.
- **`json`** — one consolidated document `{ context, summary, findings, stats }`.
- **`agent`** — newline-delimited JSON event stream, a superset of CodeRabbit's
  `--agent` protocol (`review_context`, `status`, `finding`, `error`,
  `complete`), with **richer fields** — line ranges, category, confidence,
  reasoning, and suggested patches. Drop-in for Claude Code / Cursor / Kiro.
- **`sarif`** — SARIF 2.1.0 for the GitHub Security tab and SARIF-aware IDEs.
- **`markdown`** — a self-contained report: `ergo review --format markdown > review.md`.

## Authentication

| Method | Command |
| --- | --- |
| ChatGPT/Codex subscription (browser OAuth) | `ergo auth login` |
| Headless / remote (device code) | `ergo auth login --device` |
| Import from Codex CLI | `ergo auth import` |
| OpenAI / Anthropic / compatible key | `ergo auth login --api-key --provider <p>` |

Credentials live in `~/.ergo/auth.json` (mode `0600`), and OAuth tokens are
refreshed automatically before expiry. Environment variables override stored
credentials so CI runs unattended: `ERGO_API_KEY` (+ `ERGO_PROVIDER`,
`ERGO_BASE_URL`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.

## Configuration

Drop a `.ergo.yaml` at your repo root (generate one with `ergo config init`).
It's validated against a [published JSON schema](./schema.json) for editor
autocompletion. Highlights:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/o1x3/ergo/main/schema.json
version: 1
language: en-US

reviews:
  profile: chill              # chill | assertive
  min_confidence: 0.6         # drop low-confidence findings (false-positive control)
  sequence_diagrams: true
  path_filters:               # CodeRabbit-style include/exclude globs
    - "!**/*.lock"
    - "!dist/**"
  path_instructions:
    - path: "src/**/*.ts"
      instructions: "Enforce strict null handling; avoid `any`."
  custom_agents:              # cubic-style natural-language rules
    - name: no-raw-sql
      instructions: "Flag string-concatenated SQL; require parameterized queries."
      include: ["**/*.ts"]
  tools:
    eslint: { enabled: true }
    semgrep: { enabled: true }
    gitleaks: { enabled: true }

knowledge_base:
  learnings: { scope: auto }  # ergo remembers preferences across reviews

output:
  default_format: pretty
```

Global defaults live in `~/.config/ergo/config.yaml` and are merged under your
repo config. See [`.ergo.yaml`](./.ergo.yaml) (ergo's own config) for a full example.

## Static analysis grounding

When the relevant tools are installed, ergo runs them on the changed lines and
feeds their findings to the model as grounding (the model verifies, dedupes, and
prioritizes rather than parroting raw output). Structured parsers ship for
**ruff, eslint, shellcheck, semgrep, hadolint, yamllint, mypy, gitleaks,
golangci-lint, rubocop, actionlint, stylelint** (plus markdownlint & clippy as
raw grounding) — covering Python, JS/TS, Go, Ruby, Rust, shell, Docker, YAML,
CSS/SCSS, GitHub Actions, markdown, secrets, and multi-language SAST. Run
`ergo doctor` to see what's installed; toggle per-tool in `reviews.tools`.

## CI integration

```yaml
# .github/workflows/review.yml
- run: curl -fsSL https://raw.githubusercontent.com/o1x3/ergo/main/install.sh | sh
- run: ergo review --base origin/${{ github.base_ref }} --format sarif > ergo.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: ergo.sarif }
```

Use `--fail-on major` to block merges on serious findings. ergo ships a ready
[`ergo-review.yml`](./.github/workflows/ergo-review.yml) you can copy.

## Editor & agent integration

ergo speaks two integration protocols:

- **NDJSON agent stream** — `ergo review --agent` emits one JSON event per line
  (a superset of CodeRabbit's protocol). Wire it into Claude Code, Cursor, Kiro,
  Codex CLI, or any agent that consumes streamed findings.
- **MCP server** — `ergo mcp` exposes `ergo_review`, `ergo_findings`,
  `ergo_list_learnings`, and `ergo_add_learning` over stdio. Register it with any
  MCP client:

  ```json
  // Claude Code / Cursor MCP config
  { "mcpServers": { "ergo": { "command": "ergo", "args": ["mcp"] } } }
  ```

A ready-to-install **Claude Code plugin** ships in this repo (`/ergo:review`,
`/ergo:fix` slash commands + the MCP server):

```
/plugin marketplace add o1x3/ergo
/plugin install ergo@ergo
```

## How ergo compares

| | **ergo** | CodeRabbit CLI | cubic CLI |
| --- | :---: | :---: | :---: |
| Local-first (no cloud relay) | ✅ | ❌ | ❌ |
| Per-seat / line / file caps | **none** | yes | yes |
| BYO ChatGPT/Codex subscription | ✅ | ❌ | ✅ |
| BYO API key (OpenAI/Anthropic/local) | ✅ | ❌ | partial |
| Offline / self-hosted model | ✅ | ❌ | ❌ |
| Static-analysis grounding | ✅ | ✅ | partial |
| Confidence + type gating (FP control) | ✅ | partial | ✅ |
| NDJSON agent stream | ✅ (richer) | ✅ | ❌ |
| SARIF output | ✅ | ❌ | ❌ |
| Cost/budget transparency | ✅ | ❌ | ❌ |
| Open source (MIT) | ✅ | ❌ | ❌ |

## Architecture

```
src/
  auth/        Codex-subscription OAuth (PKCE + device), credential storage
  inference/   ModelClient abstraction: Codex /responses + ai-sdk (OpenAI/Anthropic/…)
  git/         diff collection + unified-diff parser + repo metadata
  analysis/    bundled static-analysis runners and parsers
  review/      engine (serialize → findings + summary passes → filter → dedupe)
  config/      .ergo.yaml schema, loader, glob path filters
  memory/      learnings store
  output/      pretty / plain / json / agent NDJSON / SARIF / markdown
  cli/         citty commands
```

## Development

```bash
bun install
bun run dev -- --help      # run the CLI from source
bun test                   # run the test suite
bun run typecheck          # type-check
bun run check              # lint + format (biome)
bun run build:compile      # produce a standalone ./dist/ergo binary
```

## FAQ

**Does my code get uploaded anywhere?** Only to the model provider you choose, as
the API call ergo makes to review the diff. There is no ergo cloud.

**Is driving a ChatGPT subscription allowed?** ergo uses the same OAuth flow as
the official Codex CLI. Review OpenAI's terms for your plan before relying on it
in production; API-key and local-model paths are always available.

**Why Bun/TypeScript?** Single-file cross-platform binaries, a first-class AI-SDK
ecosystem, and a great TUI story — shipping speed without a runtime dependency.

## License

[MIT](./LICENSE) © Karthik Vinayan / o1x3
