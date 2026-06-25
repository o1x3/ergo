# Changelog

All notable changes to ergo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and ergo adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Review engine** — multi-pass AI review (findings + summary) over local git
  changes with severity, category, confidence, rationale, and suggested patches.
- **Inference** — bring-your-own ChatGPT/Codex subscription (PKCE + device OAuth),
  plus OpenAI / Anthropic / OpenAI-compatible API keys; `ergo auth import` for
  existing Codex CLI credentials.
- **Scopes** — `-t all|committed|uncommitted|staged`, `--base`, `--base-commit`,
  `-c/--commit`, `--dir`, `-f/--files`, `-p/--prompt`, `--instructions`.
- **Output formats** — pretty, plain, json, CodeRabbit-compatible NDJSON `--agent`,
  SARIF 2.1.0, and markdown.
- **Static-analysis grounding** — ruff, eslint, shellcheck, semgrep, hadolint,
  yamllint, mypy, gitleaks (and more), filtered to changed lines.
- **Config** — `.ergo.yaml` (profiles, path filters/instructions, custom agents,
  tool toggles, model selection) with a published JSON schema.
- **Commands** — `review`, `review findings`, `fix`, `describe`, `chat`, `auth`,
  `config`, `doctor`, `learn`, `models`, `stats`, `update`, `install-hook`, `mcp`.
- **MCP server** (`ergo mcp`) and a Claude Code plugin (`/ergo:review`, `/ergo:fix`).
- **Distribution** — cross-platform single-file binaries, `install.sh` /
  `install.ps1`, CI, and a release workflow with checksums.

[Unreleased]: https://github.com/o1x3/ergo/commits/main
