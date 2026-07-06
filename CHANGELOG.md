# Changelog

All notable changes to ergo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and ergo adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Non-ASCII filenames survive diff collection.** Git octal-escapes and quotes
  non-ASCII paths by default (`"caf\303\251.ts"`), which the diff parser
  couldn't match — such files surfaced with an empty path and dodged filters
  and limits. Diffs now run with `core.quotePath=false`.
- **Partial review coverage is no longer silent.** A failed findings batch now
  prints an error in human output (it was only visible in `--format agent`),
  so a review where some batches failed can't masquerade as a clean pass.
- Device-code login can no longer poll forever: expired codes time out after
  15 minutes, and a missing/zero/huge server poll interval is clamped to 1–60s
  instead of hot-looping the token endpoint.
- OAuth token exchange validates `access_token` presence and JSON shape before
  persisting, so a malformed response can't save an unusable credential; the
  browser-login stdin listener is paused on completion so the process exits.
- Transient network errors (connection reset, DNS blips) during Codex requests
  are retried with the same backoff as 429/5xx instead of failing the review.
- A missing executable (e.g. no `git`) reports exit 127 with a clear message
  instead of an unhandled `Bun.spawn` stack trace.
- Malformed YAML in `.ergo.yaml` is reported as a config error instead of the
  whole file being silently ignored.
- An invalid `ERGO_PROVIDER` env value fails loudly instead of silently
  routing the API key to OpenAI; `ergo doctor` reports it as a failed check.
- Config options that were parsed but silently ignored now work:
  `reviews.ignore.max_changed_lines` (skips oversized changesets),
  `model.temperature` (overrides both review passes), `output.color`
  (always/never), and custom agents' `exclude` + `file_paths` scoping.
- `--fail-on` and `install-hook --fail-on` are case-insensitive; `--files`
  accepts `./`-prefixed paths; `learn mine --commits` validates its argument;
  `--instructions` warns on unreadable files instead of skipping silently;
  `ergo update` no longer hangs on a stalled release-feed connection.
- `ergo fix` no longer rewrites files when every candidate fix was rejected
  (a no-op write bumped mtime and re-triggered watchers); `ergo chat` history
  trimming can no longer produce an Anthropic-rejected leading assistant turn.
- Static-analysis runner detects incompatible tool CLI versions (usage errors)
  and retries a legacy invocation instead of pretending the tool ran:
  gitleaks uses `dir` (v8.19+) with `detect --no-git` fallback; golangci-lint
  uses v2 `--output.json.path` with v1 `--out-format` fallback.

### Changed
- Dependencies: `ai` 5→7 (`generateObject`/`system` migrated to
  `generateText` + `Output.object` / `instructions`), `@ai-sdk/openai` and
  `@ai-sdk/anthropic` 2→4, `citty` 0.1→0.2, TypeScript 5.9→6.0 (dropped the
  deprecated `baseUrl`), Biome config migrated to 2.5.2.
- Model tables refreshed: added `claude-sonnet-5`, `claude-fable-5`,
  `claude-opus-4-7`, and the bare `claude-haiku-4-5` alias to pricing; the
  Anthropic fast model now uses the `claude-haiku-4-5` alias.

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
