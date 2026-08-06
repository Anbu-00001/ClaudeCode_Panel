---
name: check
description: Review the changes in this project for bugs and problems before committing. Use when the user asks to check, review, or look over their changes.
disable-model-invocation: true
allowed-tools: Bash(git diff *) Bash(git status *) Bash(git log *)
---

# Check my changes

Review the work in progress and report what is wrong with it.

Here is what has changed right now:

## Unstaged changes

!`git diff --stat 2>/dev/null | tail -40`

## Staged changes

!`git diff --staged --stat 2>/dev/null | tail -40`

## Files not yet tracked

!`git status --porcelain 2>/dev/null | grep '^??' | head -20`

---

Hand this off to the `reviewer` subagent using the Agent tool, so the full diff
is read in its own context instead of filling up this conversation. Ask it to
review everything shown above.

When it reports back, relay its findings as they are. Do not fix anything unless
the user asks you to.

If nothing has changed, say so and stop.
