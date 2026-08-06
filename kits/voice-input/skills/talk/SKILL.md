---
name: talk
description: Explain how to talk to Claude instead of typing, and check that dictation is set up correctly on this computer.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PROJECT_DIR}/.claude/scripts/talk.sh *)
---

# Talk instead of typing

Here is the current state of dictation on this computer:

!`"${CLAUDE_PROJECT_DIR}/.claude/scripts/talk.sh" check 2>&1 | head -20`

---

Read the output above and tell the user, in plain language:

- If everything is set up, tell them to run `.claude/scripts/talk.sh` in a second
  terminal window, then just speak. Their words get typed wherever their cursor
  is, so they should click into the Claude prompt first.
- If something is missing, walk them through the commands shown above one at a
  time. Do not run the install commands for them — these change their computer,
  so they should run each one themselves and see what happens.

Tip worth mentioning once: binding `.claude/scripts/talk.sh` to a keyboard
shortcut in their desktop settings turns it into a push-to-talk key.
