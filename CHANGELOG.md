# Changelog

All notable changes to ergo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and ergo adheres to
[Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-07-07

### Changed
- **MCP `ergo_review` reaches full parity with the CLI review**: it now runs
  static-analysis grounding on the changed files and uses incremental reuse —
  repeated calls on an unchanged tree replay from cache with zero API spend,
  and its cache entries are interchangeable with the CLI's (same prompt
  fingerprint), so an `ergo review` after an MCP review reuses findings and
  vice versa. The incremental decision now lives in one shared, tested helper
  (`planIncremental`).

## [0.3.1] - 2026-07-07

First release verified against the live Codex backend end-to-end (review,
incremental zero-spend replay, and `ergo usage` rate-limit capture) — which
immediately surfaced the first fix below.

### Fixed
- **Mid-run token refresh.** The ChatGPT backend can invalidate an access
  token before its local expiry (the official Codex CLI rotates tokens).
  A 401 now triggers one refresh-and-retry with the stored refresh token
  (persisted for the next run); if refresh fails, the error tells you to
  run `ergo auth import` / `ergo auth login` instead of dying cryptically.
- Guideline glob patterns (e.g. `.cursor/rules/**`) now also match
  **untracked** files (`git ls-files --others --exclude-standard`), so a
  fresh rules directory feeds reviews before its first commit — found by
  ergo reviewing its own release commit.
- CI: bumped `actions/checkout`→v7, `upload-artifact`→v7,
  `download-artifact`→v8, `codeql-action`→v4 (Node 20 deprecation).

## [0.3.0] - 2026-07-07

### Added
- **Incremental reviews** (`reviews.incremental`, on by default). ergo hashes
  each file's rendered diff; files byte-identical to the last review carry
  their findings forward instead of being re-reviewed, and a fully-unchanged
  changeset replays instantly with zero API spend. Reuse requires the same
  model + profile and an equal-or-looser confidence filter, is disabled by
  `--prompt`/`--instructions`, and can be skipped per run with the new
  `--full` flag. The summary pass still covers the whole changeset.
- **Static analysis runs in parallel** (up to 4 tools concurrently) with
  deterministic output ordering — multi-linter repos ground reviews faster.
- **More config now enforced:** `reviews.enabled: false` skips reviews (no
  credential needed — useful as a per-repo opt-out for hook rollouts);
  `reviews.ignore.head_branches` / `base_branches` skip matching branches;
  `knowledge_base.context_files.patterns` and `code_guidelines.filePatterns`
  now drive which guideline files are gathered (globs match tracked files via
  `git ls-files`, so `node_modules` is never scanned); `tools.<name>.level`
  maps to shellcheck `-S`, semgrep `--severity`, and eslint `--quiet`.
- `ergo findings` honors `output.default_format` and `output.color`, and
  `--format agent` now replays the full NDJSON stream (it previously printed
  nothing).
- **Every documented option now does something.** `reviews.sequence_diagrams`
  and `reviews.changed_files_summary` gate their sections (the summary prompt
  is told not to produce a diagram when disabled); `output.markdown_diagrams`
  drops the Mermaid block from markdown reports; `model.provider` mismatches
  with the active credential are warned about; `ergo chat`, `ergo describe`,
  and `ergo learn mine` honor `model.default` from config; the MCP
  `ergo_review` tool applies learnings/path instructions/custom agents/tone
  and persists its result (so `ergo_findings` and `ergo fix` work after it);
  compat-only keys (`web_search`, `type_verify`, PR-specific ignores, …) are
  labeled as such in `schema.json`.
- `--profile` is validated; conflicting target flags (`--commit` + `--base` +
  `--type` …) error instead of resolving by silent precedence; `--type` help
  text explains that `all`/`uncommitted` both mean the working tree vs HEAD.

### Fixed
- **Adversarial review of the incremental-reuse design (116-agent workflow)
  hardened it before release:**
  - A partially-failed review (some findings batches erroring) no longer
    poisons the cache: files the model never saw are excluded from the reuse
    hashes, reported as `stats.unreviewedFiles`, and called out loudly in
    terminal output — a retry re-reviews exactly those files.
  - Findings reuse now requires an identical **prompt fingerprint** (guidelines,
    learnings, path instructions, custom agents, `--prompt` focus, tone,
    language, reasoning effort) plus the same model and profile — so editing
    AGENTS.md, adding a learning, or running `--deep` invalidates reuse instead
    of silently replaying stale findings.
  - The zero-spend fast path only replays the cached summary when the file SET
    is identical; if files left the changeset, findings are still carried but
    the summary is regenerated.
  - Carried findings are streamed before the `review_completed` NDJSON status
    event; `--budget` validation runs on every path and the estimate includes
    the whole-changeset summary pass; `ignore.base_branches` now also applies
    to the auto-detected base.
  - Whole-repo scanners (gitleaks, golangci-lint, clippy) run serially so they
    can't race concurrent per-file linters; timed-out tools are reported as
    skipped instead of "ran" with silently-dropped findings; semgrep's `level`
    now means *minimum* severity (it was an exact-match filter that dropped
    ERROR findings when set to `warning`).
  - Guideline gathering reads explicitly-named files before glob matches so a
    pile of `.cursor/rules/*` can't evict AGENTS.md/CLAUDE.md; the
    `knowledge_base.opt_out` master switch now also disables guidelines.
  - `extractJson` no longer descends into a malformed object and returns a
    nested fragment that happens to parse.
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
