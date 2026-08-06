#!/usr/bin/env bash
#
# ccpanel — check before changing something load-bearing
#
# Claude sometimes edits more than you asked for. This does not try to guess
# what you asked for — it can't. Instead it stops on the small set of files
# where a surprise edit does real damage, and asks you first.
#
# Fails open: any error, and the edit is allowed through.

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

TOOL=$(read_field '.tool_name' 'o.tool_name' 'o.get("tool_name")')
case "$TOOL" in Edit|Write|NotebookEdit) ;; *) exit 0 ;; esac

FILE=$(read_field '.tool_input.file_path' 'o.tool_input&&o.tool_input.file_path' 'o.get("tool_input",{}).get("file_path")')
[ -z "$FILE" ] && exit 0

# Only existing files matter: creating a new one destroys nothing.
[ -e "$FILE" ] || exit 0

BASE=$(basename "$FILE")
REASON=""

case "$FILE" in
  */.claude/settings.json|*/.claude/settings.local.json|*/.claude/*.json)
    REASON="This changes how Claude Code itself is set up for this project." ;;
  */.claude/hooks/*|*/.claude/agents/*|*/.claude/skills/*)
    REASON="This changes one of the automatic checks or helpers you set up." ;;
  */CLAUDE.md|CLAUDE.md|*/.claude/CLAUDE.md)
    REASON="This rewrites the instructions you wrote for Claude." ;;
  */.github/workflows/*)
    REASON="This changes what runs automatically when you push code." ;;
  */migrations/*|*/migrate/*)
    REASON="This changes a database migration, which may already have run." ;;
esac

if [ -z "$REASON" ]; then
  case "$BASE" in
    package-lock.json|pnpm-lock.yaml|yarn.lock|Cargo.lock|poetry.lock|go.sum|composer.lock)
      REASON="This rewrites the file that pins your exact dependency versions." ;;
    Dockerfile|docker-compose.yml|docker-compose.yaml|Makefile)
      REASON="This changes how your project gets built and run." ;;
    .gitignore|.npmrc|.env.example)
      REASON="This changes a project-wide setting other people rely on." ;;
  esac
fi

[ -z "$REASON" ] && exit 0

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
MSG="$REASON
Check it's really meant to change, then allow it."

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$(esc "$MSG" | awk 'BEGIN{ORS=""}{print (NR>1?"\\n":"") $0}')"
exit 0
