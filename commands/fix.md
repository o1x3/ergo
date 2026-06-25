---
description: Apply ergo's suggested fixes from the most recent review to the working tree. Use when the user wants to auto-apply review fixes.
argument-hint: "[--all | --id ERG-1,ERG-2]"
allowed-tools: Bash(ergo:*) Bash(git:*) Read
---

Apply suggested fixes from the last ergo review.

1. If no review exists yet, run `ergo review --plain` first.
2. Show the fixable findings (`ergo fix` with no args lists them).
3. Apply the requested fixes: `ergo fix $ARGUMENTS` (default: confirm before applying; the user can pass `--all` or specific `--id`s).
4. After applying, show `git diff` of the changed files and summarize what changed so the user can review before committing.
