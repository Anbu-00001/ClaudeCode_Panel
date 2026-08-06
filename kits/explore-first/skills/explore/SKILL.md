---
name: explore
description: Search the project to find where something lives and how it fits together, without filling up the main conversation.
context: fork
agent: Explore
disable-model-invocation: true
argument-hint: [what you're looking for]
---

# Find out how this works

Find and explain: $ARGUMENTS

Work through the project and report back:

1. **Where it lives** — the files and functions that actually implement this,
   with paths and line numbers.
2. **How it fits together** — what calls it, what it calls, and what would break
   if it changed.
3. **Anything surprising** — special cases, workarounds, or comments explaining
   why it is the way it is.

Read whatever you need to answer properly, but report back only the conclusions
and the specific places worth looking at. Do not paste whole files.

If you cannot find it, say what you searched for so the user can rename it.
