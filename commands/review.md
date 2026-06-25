---
description: Review the current git changes with ergo and summarize findings by severity. Use when the user asks for a code review of local, uncommitted, staged, or branch changes.
argument-hint: "[--base <branch>] [--type uncommitted|staged|committed]"
allowed-tools: Bash(ergo:*) Bash(git:*) Read
---

Run an ergo AI code review of the current changes and present the results clearly.

1. Run `ergo review --plain $ARGUMENTS` (pass through any `--base`/`--type` the user gave; default reviews uncommitted changes).
2. Summarize the findings grouped by severity (critical → major → minor → suggestion), each with `file:line`, a one-line explanation, and the suggested fix if present.
3. If there are fixable findings, offer to apply them with `ergo fix --all` (or `ergo fix --id ERG-1,ERG-2` for specific ones), and explain that fixes land in the working tree for review before committing.
4. If there are no findings, say so succinctly.

Do not invent findings — report only what `ergo` outputs.
