#!/usr/bin/env bash
#
# ccpanel — warn before a big deletion
#
# A PreToolUse hook. Claude Code pipes the pending tool call in as JSON on
# stdin; we decide whether it looks irreversible and wide, and if so ask
# Claude Code to stop and confirm with the user.
#
# Three rules govern this file:
#
#   1. FAIL OPEN. Any error, timeout, or unparseable input exits 0 and allows
#      the call. A safety feature that bricks a session gets uninstalled, and
#      then there is no safety feature at all.
#   2. NO NETWORK, NO AI. Pattern matching plus git. That is why it can run on
#      every tool call without costing anything.
#   3. FAST. Everything is bounded; the whole script is capped well under 200ms.
#
# We reply with permissionDecision "ask", never "deny". We are warning, not
# policing — the user stays in charge. "deny" also makes Claude stop and go
# idle rather than let the user decide.

# Never let a failing command abort the script: every path must reach exit 0.
set +e
umask 077

# Everything below is best-effort. If anything at all goes wrong, allow.
trap 'exit 0' ERR

MAX_INPUT_BYTES=1000000   # ignore anything past 1MB; a real tool call is tiny
GIT_TIMEOUT=0.1           # each git call is individually bounded
FIND_LIMIT=5000           # stop counting files past this

# ---------------------------------------------------------------------------
# Read input, bounded so a huge payload can't hang or exhaust memory.
# ---------------------------------------------------------------------------
INPUT=$(head -c "$MAX_INPUT_BYTES" 2>/dev/null)
[ -z "$INPUT" ] && exit 0

# ---------------------------------------------------------------------------
# Extract fields. Claude Code can be installed without Node (native installer)
# and jq is not guaranteed either, so try each parser in turn and allow the
# call if none is available. The installer's self-check warns when this
# machine has no parser, so nobody believes they are protected when they
# aren't.
# ---------------------------------------------------------------------------
extract() {
  # $1 = jq filter, $2 = equivalent JS property path
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$INPUT" | node -e '
      let raw="";
      process.stdin.on("data",d=>raw+=d);
      process.stdin.on("end",()=>{
        try{const o=JSON.parse(raw);const v='"$2"';if(v!=null)process.stdout.write(String(v));}
        catch(e){}
      });' 2>/dev/null && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$INPUT" | python3 -c '
import sys,json
try:
    o=json.load(sys.stdin)
    v='"$3"'
    if v is not None: sys.stdout.write(str(v))
except Exception: pass' 2>/dev/null && return 0
  fi
  return 1
}

TOOL_NAME=$(extract '.tool_name' 'o.tool_name' 'o.get("tool_name")')
[ -z "$TOOL_NAME" ] && exit 0

case "$TOOL_NAME" in
  Bash|Edit|Write) ;;
  *) exit 0 ;;
esac

COMMAND=$(extract '.tool_input.command' 'o.tool_input&&o.tool_input.command' 'o.get("tool_input",{}).get("command")')
FILE_PATH=$(extract '.tool_input.file_path' 'o.tool_input&&o.tool_input.file_path' 'o.get("tool_input",{}).get("file_path")')

# ---------------------------------------------------------------------------
# Reply helpers
# ---------------------------------------------------------------------------
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""}{print (NR>1?"\\n":"") $0}'
}

# $1 = line one, $2 = line two, $3 = "loud" to also ring the terminal
respond_ask() {
  local reason title seq esc_reason
  reason="$1"
  [ -n "$2" ] && reason="$1
$2"
  esc_reason=$(json_escape "$reason")

  seq=""
  if [ "$3" = "loud" ]; then
    # OSC 777 desktop notification plus BEL. Both are on Claude Code's
    # allowed list of escape sequences for hooks.
    title="About to delete something big"
    seq=$(printf '\033]777;notify;%s;%s\007\007' "$title" "$1" \
          | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\x1b/\\u001b/g' -e 's/\x07/\\u0007/g')
  fi

  if [ -n "$seq" ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"},"systemMessage":"%s","terminalSequence":"%s"}\n' \
      "$esc_reason" "$esc_reason" "$seq"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"},"systemMessage":"%s"}\n' \
      "$esc_reason" "$esc_reason"
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Paths we never warn about: build output, caches, temp. Deleting these is
# routine and warning about them is how a safety prompt becomes noise the
# user reflexively approves.
# ---------------------------------------------------------------------------
is_ignorable_path() {
  case "$1" in
    */node_modules|*/node_modules/*|node_modules|node_modules/*) return 0 ;;
    */dist|*/dist/*|dist|dist/*) return 0 ;;
    */build|*/build/*|build|build/*) return 0 ;;
    */.next|*/.next/*|.next|.next/*) return 0 ;;
    */target|*/target/*|target|target/*) return 0 ;;
    */__pycache__|*/__pycache__/*|__pycache__|__pycache__/*) return 0 ;;
    */.venv|*/.venv/*|.venv|.venv/*) return 0 ;;
    /tmp|/tmp/*|/var/tmp/*) return 0 ;;
    *.pyc|*.log) return 0 ;;
  esac
  return 1
}

# Anything git already ignores is build output by definition.
is_git_ignored() {
  command -v git >/dev/null 2>&1 || return 1
  timeout "$GIT_TIMEOUT" git check-ignore -q -- "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Git awareness — the sentence that actually stops a bad approval.
# ---------------------------------------------------------------------------
count_unsaved() {
  command -v git >/dev/null 2>&1 || { printf '0'; return; }
  timeout "$GIT_TIMEOUT" git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '0'; return; }
  local n
  n=$(timeout "$GIT_TIMEOUT" git status --porcelain -- "$@" 2>/dev/null | grep -c . 2>/dev/null)
  [ -z "$n" ] && n=0
  printf '%s' "$n"
}

count_files() {
  local target="$1" n
  [ -e "$target" ] || { printf '0'; return; }
  if [ -d "$target" ]; then
    n=$(timeout 0.12 find "$target" -type f 2>/dev/null | head -n "$FIND_LIMIT" | grep -c . 2>/dev/null)
  else
    n=1
  fi
  [ -z "$n" ] && n=0
  printf '%s' "$n"
}

plural() { [ "$1" = "1" ] && printf '%s' "$2" || printf '%s' "$3"; }

# ---------------------------------------------------------------------------
# Edit / Write: only credentials are worth interrupting for. Ordinary file
# edits are the entire point of the tool.
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then
  [ -z "$FILE_PATH" ] && exit 0
  case "$FILE_PATH" in
    *.env|*.env.*|*/.env|*.pem|*.key|*/id_rsa|*/id_ed25519|*/credentials|*/.npmrc|*/.netrc)
      [ -e "$FILE_PATH" ] || exit 0
      respond_ask \
        "This overwrites a file that stores your passwords or keys." \
        "If it wasn't saved anywhere else, you can't get it back." \
        "loud"
      ;;
  esac
  exit 0
fi

# ---------------------------------------------------------------------------
# Bash: the real surface.
# ---------------------------------------------------------------------------
[ -z "$COMMAND" ] && exit 0

# Collapse whitespace once so every pattern below can assume single spaces.
CMD=$(printf '%s' "$COMMAND" | tr '\n\t' '  ' | tr -s ' ')

# --- Disk-level: unrecoverable, no further questions asked ------------------
if printf '%s' "$CMD" | grep -qE '(^|[;&|] *)(dd +if=|mkfs(\.[a-z0-9]+)? |shred )' \
   || printf '%s' "$CMD" | grep -qE '> */dev/(sd|nvme|hd|disk)'; then
  respond_ask \
    "This writes directly to a disk and can destroy everything on it." \
    "There is no undo for this one." \
    "loud"
fi

# --- Databases --------------------------------------------------------------
if printf '%s' "$CMD" | grep -qiE 'drop +(table|database|schema)|truncate +table'; then
  respond_ask \
    "This permanently removes a database table or a whole database." \
    "The data is gone unless you have a separate backup." \
    "loud"
fi

if printf '%s' "$CMD" | grep -qiE 'delete +from +[a-z0-9_."`]+ *(;|$)'; then
  respond_ask \
    "This empties an entire database table — every row, not just some." \
    "It looks like a filter was left off by accident." \
    "loud"
fi

# --- Infrastructure ---------------------------------------------------------
if printf '%s' "$CMD" | grep -qE 'terraform +destroy|kubectl +delete|docker +system +prune +.*-a|docker +volume +rm'; then
  respond_ask \
    "This tears down running infrastructure, not just local files." \
    "Other people may be relying on it right now." \
    "loud"
fi

# --- Git: discards work that was never committed ----------------------------
if printf '%s' "$CMD" | grep -qE 'git +reset +--hard|git +clean +-[a-z]*f|git +checkout +-- +\.'; then
  UNSAVED=$(count_unsaved)
  if [ "$UNSAVED" -gt 0 ] 2>/dev/null; then
    respond_ask \
      "This throws away your uncommitted changes." \
      "$UNSAVED $(plural "$UNSAVED" "file has" "files have") edits that aren't saved in git yet." \
      "loud"
  fi
  # Nothing uncommitted means nothing to lose — stay quiet.
  exit 0
fi

if printf '%s' "$CMD" | grep -qE 'git +push +.*(--force|-f)( |$)'; then
  case "$CMD" in
    *--force-with-lease*)
      respond_ask "This rewrites the shared history on the branch you're pushing to." \
                  "Teammates who already pulled it will hit conflicts." ;;
    *)
      respond_ask "This overwrites the shared branch with your local version." \
                  "Anything a teammate pushed that you don't have locally is lost." "loud" ;;
  esac
fi

# --- rm ---------------------------------------------------------------------
if printf '%s' "$CMD" | grep -qE '(^|[;&|] *)(sudo +)?rm( |$)'; then

  # Catastrophic targets first: these are never a good idea.
  if printf '%s' "$CMD" | grep -qE 'rm +(-[a-zA-Z]+ +)*(/|~|/\*|~/\*|\$HOME|\.\.)( |$|/\*)'; then
    respond_ask \
      "This tries to delete your whole home folder or the whole disk." \
      "That is almost certainly not what was meant." \
      "loud"
  fi

  # Collect the paths being removed (skip flags).
  PATHS=""
  COUNT=0
  for word in $CMD; do
    case "$word" in
      rm|sudo|-*|'&&'|'||'|';') continue ;;
    esac
    PATHS="$PATHS $word"
    COUNT=$((COUNT + 1))
  done
  [ "$COUNT" -eq 0 ] && exit 0

  # Every path is build output or already git-ignored → routine cleanup.
  ALL_IGNORABLE=1
  for p in $PATHS; do
    if ! is_ignorable_path "$p" && ! is_git_ignored "$p"; then
      ALL_IGNORABLE=0
      break
    fi
  done
  [ "$ALL_IGNORABLE" -eq 1 ] && exit 0

  RECURSIVE=0
  printf '%s' "$CMD" | grep -qE 'rm +(-[a-zA-Z]*r[a-zA-Z]* +)' && RECURSIVE=1

  # A bare glob, a recursive delete, or a bulk list is worth a look.
  BARE_GLOB=0
  printf '%s' "$CMD" | grep -qE 'rm +(-[a-zA-Z]+ +)*\*' && BARE_GLOB=1

  if [ "$RECURSIVE" -eq 0 ] && [ "$BARE_GLOB" -eq 0 ] && [ "$COUNT" -le 5 ]; then
    exit 0
  fi

  # Count what actually disappears, and how much of it isn't saved in git.
  TOTAL=0
  for p in $PATHS; do
    n=$(count_files "$p")
    TOTAL=$((TOTAL + n))
  done
  [ "$TOTAL" -eq 0 ] && exit 0

  # shellcheck disable=SC2086
  UNSAVED=$(count_unsaved $PATHS)

  if [ "$UNSAVED" -gt 0 ] 2>/dev/null; then
    respond_ask \
      "This deletes $TOTAL $(plural "$TOTAL" "file" "files") and can't be undone." \
      "$UNSAVED of them $(plural "$UNSAVED" "has" "have") changes that aren't saved in git." \
      "loud"
  fi

  if [ "$COUNT" -gt 5 ]; then
    respond_ask \
      "This deletes $TOTAL $(plural "$TOTAL" "file" "files") across $COUNT places at once." \
      "All of it is saved in git, so you could get it back."
  fi

  if [ "$TOTAL" -ge 25 ]; then
    respond_ask \
      "This deletes $TOTAL files." \
      "All of it is saved in git, so you could get it back."
  fi

  exit 0
fi

# --- Deleting credentials by any other means --------------------------------
if printf '%s' "$CMD" | grep -qE '(rm|shred|mv) +.*(\.env|\.pem|\.key|id_rsa|id_ed25519|credentials)( |$)'; then
  respond_ask \
    "This removes a file that stores your passwords or keys." \
    "If it isn't backed up somewhere else, it's gone for good." \
    "loud"
fi

exit 0
