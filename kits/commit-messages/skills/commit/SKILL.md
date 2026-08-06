---
name: commit
description: Write a commit message for the currently staged changes and show it for approval before committing.
disable-model-invocation: true
allowed-tools: Bash(git diff *) Bash(git status *) Bash(git log *)
---

# Write my commit message

## What is staged right now

!`git diff --staged --stat 2>/dev/null | tail -30`

## The actual changes

!`git diff --staged 2>/dev/null | head -300`

## How this project words its messages

!`git log --oneline -15 2>/dev/null`

---

Write a commit message for the staged changes above.

- Match the style already used in this project's history shown above — if those
  messages use a prefix like `fix:` or `feat:`, use the same convention.
- First line: under 72 characters, present tense, describing the effect of the
  change rather than listing the files touched.
- If the change is not self-explanatory, add a blank line and two or three lines
  explaining why it was needed. Skip this for small obvious changes.
- Never invent a reason. If the "why" isn't visible in the diff, leave it out and
  say you left it out.

Show the message and stop. Do not commit. Wait for the user to approve it, and
only then run `git commit`.

If nothing is staged, say so and suggest `git add` first.
