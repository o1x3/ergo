# Changelog

All notable changes to ergo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and ergo adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-06-26

### Fixed
- Three adversarial red-team rounds hardened the codebase (57 verified bugs):
  - **diff parser** no longer misreads content lines starting with `-- `/`++ `
    as file headers (was dropping lines / corrupting line numbers).
  - **fix** detects stale patches via content hash, skips overlapping findings,
    guards path traversal, and preserves line endings.
  - **review** honors `config output.default_format`, validates `--fail-on` /
    `--type` / `--min-confidence`, emits well-formed empty docs for json/sarif,
    and emits structured agent errors on early failure.
  - **inference** surfaces ai-sdk stream errors; codex SSE handles CRLF, flushes
    the final frame, cancels the body on early exit, and backoff is abort-aware;
    provider-aware cost accounting.
  - **outputs** strip terminal escapes, clamp SARIF line numbers, and escape
    markdown table cells / code fences. **learnings** use collision-free ids and
    atomic writes.
- Releases now ship only platform binaries (dropped a stray sourcemap).

### Added
- Static-analysis parsers for golangci-lint, rubocop, actionlint, stylelint;
  text-only tools (markdownlint, clippy) now contribute grounding.

## [0.1.0] - 2026-06-25

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

[0.1.1]: https://github.com/o1x3/ergo/releases/tag/v0.1.1
[0.1.0]: https://github.com/o1x3/ergo/releases/tag/v0.1.0
