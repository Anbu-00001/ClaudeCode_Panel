#!/usr/bin/env bash
#
# ccpanel — save a note before the conversation gets shortened
#
# When a conversation gets long, Claude Code summarises it to free up room.
# The summary is shorter than the real thing, so details get lost: which files
# were touched, what was already tried, what failed.
#
# This runs just before that happens and writes a plain note to disk, so the
# details survive somewhere Claude can read them back.
#
# Fails open: any error and compaction proceeds untouched. It never blocks.

set +u
trap 'exit 0' ERR

INPUT=$(head -c 1000000 2>/dev/null | tr -d '\000' 2>/dev/null)
[ -z "$INPUT" ] && exit 0

read_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$INPUT" | node -e '
      let r="";process.stdin.on("data",d=>r+=d);process.stdin.on("end",()=>{
      try{const o=JSON.parse(r);const v='"$2"';if(v!=null)process.stdout.write(String(v));}catch(e){}});' 2>/dev/null && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$INPUT" | python3 -c '
import sys,json
try:
    o=json.load(sys.stdin); v='"$3"'
    if v is not None: sys.stdout.write(str(v))
except Exception: pass' 2>/dev/null && return 0
  fi
  return 1
}

CWD=$(read_field '.cwd' 'o.cwd' 'o.get("cwd")')
TRIGGER=$(read_field '.trigger' 'o.trigger' 'o.get("trigger")')
[ -z "$CWD" ] && CWD="$PWD"

NOTE_DIR="$CWD/.claude"
NOTE="$NOTE_DIR/where-we-got-to.md"
mkdir -p "$NOTE_DIR" 2>/dev/null || exit 0

WHEN=$(date '+%Y-%m-%d %H:%M' 2>/dev/null)

{
  printf '# Where we got to\n\n'
  printf 'Written automatically at %s, just before the conversation was shortened' "$WHEN"
  [ "$TRIGGER" = "auto" ] && printf ' (it had filled up)' || printf ' (you asked for it)'
  printf '.\n\n'

  printf '## Files changed but not yet saved to git\n\n'
  if command -v git >/dev/null 2>&1 && timeout 2 git -C "$CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    CHANGED=$(timeout 3 git -C "$CWD" status --porcelain 2>/dev/null | grep -v "where-we-got-to.md" | head -40)
    if [ -n "$CHANGED" ]; then printf '```\n%s\n```\n\n' "$CHANGED"
    else printf 'Nothing — everything is saved in git.\n\n'; fi

    printf '## Recent commits\n\n```\n'
    timeout 3 git -C "$CWD" log --oneline -10 2>/dev/null
    printf '```\n\n'

    BRANCH=$(timeout 2 git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)
    [ -n "$BRANCH" ] && printf 'On branch: `%s`\n\n' "$BRANCH"
  else
    printf 'This folder is not tracked by git, so changed files could not be listed.\n\n'
  fi

  printf -- '---\n\nIf something seems to have been forgotten after this point, read this file.\n'
} > "$NOTE" 2>/dev/null

exit 0
