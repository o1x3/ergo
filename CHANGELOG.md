# Changelog

All notable changes to ergo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and ergo adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-26

### Added
- **`ergo usage`** — your remaining Codex subscription quota (5-hour and weekly
  rate-limit windows) with used %, reset times, and remaining %. Parsed from the
  Codex response headers and recorded after every review.
- **`ergo stats` dashboard** — reviews, findings, tokens, active days, current
  and longest streaks (with dates), peak hour, a top-models bar chart, and a
  GitHub-style activity heatmap. Windowed: `ergo stats 7d` / `30d` / `1m` or any
  `Nd` / `Nw` / `Nm` (calendar months); bare `ergo stats` is all-time.
- A dependency-free terminal layout toolkit (`src/output/style.ts` +
  `layout.ts`): ANSI/Unicode-aware width, padding, truncation and word-wrap,
  hairline cards, gauges, the heatmap, and severity chips/glyphs — shared by the
  stats, usage, and review surfaces.

### Changed
- **Prettier review output.** Markdown summaries and walkthroughs render with
  real terminal styling instead of raw `##`/`**`. Findings use shape-coded
  severity glyphs (`◆ ● ○`) and chips, a compact tally, wrapped descriptions, a
  dim `category · file:line · id` meta line, a confidence meter shown only when
  confidence < 0.80, and colored suggested-fix diffs. Emoji removed so columns
  never drift; everything degrades cleanly under `NO_COLOR`.

### Fixed
- `ergo <typo>` (e.g. `ergo helo`) no longer silently starts a review — unknown
  commands error; `ergo help` and `ergo chat` route correctly (`chat` was
  missing from the default-command allow-list).
- `--format <invalid>` now errors instead of silently rendering pretty output
  (which could corrupt a piped `--format json`).
- Codex OAuth callback port corrected to the registered `1455`.

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
