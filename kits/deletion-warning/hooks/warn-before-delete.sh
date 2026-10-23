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
#   3. FAST. Everything is bounded, and on a normal repo the whole script
#      finishes well under 200ms. Git alone may take up to 2s on a slow disk:
#      cutting it off sooner used to turn "git didn't answer" into "all of it
#      is saved in git", and a wrong reassurance is worse than a short wait.
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
GIT_TIMEOUT=2             # each git call is individually bounded
FIND_TIMEOUT=0.5          # counting files gives up after this long
FIND_LIMIT=5000           # stop counting files past this
MAX_PARSE_CHARS=8192      # longer commands aren't read word by word

# ---------------------------------------------------------------------------
# Read input, bounded so a huge payload can't hang or exhaust memory.
# ---------------------------------------------------------------------------
# Null bytes are stripped first: bash warns about them during command
# substitution, and a safety tool must not print noise onto stderr.
INPUT=$(head -c "$MAX_INPUT_BYTES" 2>/dev/null | tr -d '\000' 2>/dev/null)
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

# Claude's shell keeps its own working directory between commands, and Claude
# Code reports it as "cwd". Relative paths in the command mean that folder,
# not wherever this hook happened to start.
HOOK_CWD=$(extract '.cwd' 'o.cwd' 'o.get("cwd")')
if [ -n "$HOOK_CWD" ] && [ -d "$HOOK_CWD" ]; then cd -- "$HOOK_CWD" 2>/dev/null; fi

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

# Runs a command with a time limit. `timeout` is GNU coreutils, which macOS
# doesn't ship (Homebrew names it gtimeout), so without either the command
# runs unbounded rather than not at all — a check that silently never runs
# is how a safety tool ends up claiming everything is fine.
bounded() {
  local limit="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$limit" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$limit" "$@"
  else
    "$@"
  fi
}

# git, with the repository's own config unable to run programs: the user may
# be working in a clone a stranger wrote the .git/config for.
safe_git() {
  GIT_CONFIG_NOSYSTEM=1 GIT_LITERAL_PATHSPECS=1 bounded "$GIT_TIMEOUT" \
    git -c core.fsmonitor= -c core.hooksPath=/dev/null "$@"
}

# Anything git already ignores is build output by definition.
# Asked from the path's own folder, because a `cd` earlier in the command can
# put it in a different repository from the one the hook runs in.
is_git_ignored() {
  local p="$1" dir
  command -v git >/dev/null 2>&1 || return 1
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  dir=$(dirname -- "$p")
  [ -d "$dir" ] || return 1
  safe_git -C "$dir" check-ignore -q -- "$p" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Git awareness — the sentence that actually stops a bad approval.
#
# "Nothing unsaved" is only ever said after git has actually answered. Not a
# repo, git missing, or git too slow each mean we don't know, and the user
# must hear that rather than a reassurance we can't back up.
# ---------------------------------------------------------------------------

# Prints, for one existing path, how many of its files have changes git
# hasn't saved (a number), "nogit" when it isn't inside a git work tree at
# all, or "unknown" when git couldn't answer.
#
# After that first line come the things git ignores inside the path, one per
# line. Git never saves an ignored file (a .env, local config, keys), so
# "saved in git" must never be said about them. Build output (node_modules,
# dist, ...) is prefixed "build:" because it can be rebuilt. Plain
# `git status --untracked-files=all` leaves ignored files out entirely, which
# is how a folder holding secrets.env used to be called "all saved".
# "--ignored=matching" names an ignored folder once instead of every file in
# it, so a node_modules inside costs one line.
unsaved_in() {
  local p="$1" dir out rc line name n=0 ign=""
  command -v git >/dev/null 2>&1 || { printf 'unknown\n'; return 0; }
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  if [ -d "$p" ]; then dir="$p"; else dir=$(dirname -- "$p"); fi

  out=$(safe_git -C "$dir" rev-parse --is-inside-work-tree 2>/dev/null)
  rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then printf 'unknown\n'; return 0; fi
  [ "$out" = "true" ] || { printf 'nogit\n'; return 0; }

  out=$(safe_git -C "$dir" status --porcelain --ignored=matching --untracked-files=all -- "$p" 2>/dev/null)
  rc=$?
  [ "$rc" -eq 0 ] || { printf 'unknown\n'; return 0; }
  while IFS= read -r line; do
    case "$line" in
      '') ;;
      '!! '*)
        name=${line#!! }
        name=${name%/}
        if is_ignorable_path "$name"; then ign="${ign}build:$name
"; else ign="$ign$name
"; fi
        ;;
      *) n=$((n + 1)) ;;
    esac
  done <<EOF_STATUS
$out
EOF_STATUS
  printf '%s\n%s' "$n" "$ign"
  return 0
}

# Same answer for a list of paths: a number when every one is in git and git
# answered, otherwise the worst of "nogit" / "unknown". Any unsaved count
# wins, because that is the most specific thing we can say. The ignored lines
# from every path follow, as for unsaved_in.
count_unsaved() {
  local p r first total=0 state="" ign=""
  for p in "$@"; do
    r=$(unsaved_in "$p")
    first=${r%%
*}
    [ "$first" = "$r" ] || ign="$ign${r#*
}
"
    case "$first" in
      nogit) state="nogit" ;;
      unknown) [ "$state" = "nogit" ] || state="unknown" ;;
      *) [ "$first" -gt 0 ] 2>/dev/null && total=$((total + first)) ;;
    esac
  done
  if [ "$total" -gt 0 ] || [ -z "$state" ]; then printf '%s\n' "$total"; else printf '%s\n' "$state"; fi
  printf '%s' "$ign"
  return 0
}

count_files() {
  local target="$1" n
  [ -e "$target" ] || { printf '0'; return; }
  if [ -d "$target" ]; then
    n=$(bounded "$FIND_TIMEOUT" find "$target" -type f 2>/dev/null | head -n "$FIND_LIMIT" | grep -c . 2>/dev/null)
  else
    n=1
  fi
  [ -z "$n" ] && n=0
  printf '%s' "$n"
}

plural() { [ "$1" = "1" ] && printf '%s' "$2" || printf '%s' "$3"; }

# ---------------------------------------------------------------------------
# Reading an rm command the way the shell would. Splitting on spaces alone
# turns `rm -rf "my photos"` into two paths that don't exist, and leaves
# `~/stuff` and `$HOME/stuff` as names nobody has — so all three used to pass
# silently. This handles quotes, backslashes, a leading ~, and $HOME / ${HOME};
# any other variable or `$(...)` can't be known in advance and is marked so.
#
# Fills WORDS[], plus WSEP[i]=1 for a command separator, WUNRES[i]=1 for a
# word that still depends on something only known at run time, and
# WGLOB[i]=1 for a word with an unquoted * ? or [.
# ---------------------------------------------------------------------------
_word=""
_inword=0
_unres=0
_glob=0
_skipnext=0

flush_word() {
  if [ "$_inword" -eq 1 ]; then
    if [ "$_skipnext" -eq 1 ]; then
      _skipnext=0 # the file after a redirection isn't something rm deletes
    else
      WORDS+=("$_word")
      WSEP+=(0)
      WUNRES+=("$_unres")
      WGLOB+=("$_glob")
    fi
  fi
  _word=""
  _inword=0
  _unres=0
  _glob=0
}

push_separator() {
  flush_word
  WORDS+=("$1")
  WSEP+=(1)
  WUNRES+=(0)
  WGLOB+=(0)
}

# $1 = the text from a `$` onwards. Appends $HOME's value and prints how many
# characters were used, or marks the word unknown and prints 1.
expand_dollar() {
  local rest="$1"
  if [ -n "${HOME:-}" ]; then
    case "$rest" in
      '${HOME}'*) _word+="$HOME"; EXPANDED=7; return 0 ;;
      '$HOME'*)
        case "${rest:5:1}" in
          [A-Za-z0-9_]) ;;
          *) _word+="$HOME"; EXPANDED=5; return 0 ;;
        esac
        ;;
    esac
  fi
  _unres=1
  _word+='$'
  EXPANDED=1
}

tokenize() {
  local s="$1" i=0 n=${#1} c q=""
  WORDS=()
  WSEP=()
  WUNRES=()
  WGLOB=()
  _word=""
  _inword=0
  _unres=0
  _glob=0
  _skipnext=0
  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    if [ -n "$q" ]; then
      if [ "$c" = "$q" ]; then
        q=""
      elif [ "$q" = '"' ] && [ "$c" = '\' ]; then
        i=$((i + 1))
        _word+=${s:i:1}
      elif [ "$q" = '"' ] && [ "$c" = '$' ]; then
        expand_dollar "${s:i}"
        i=$((i + EXPANDED - 1))
      elif [ "$q" = '"' ] && [ "$c" = '`' ]; then
        _unres=1
        _word+=$c
      else
        _word+=$c
      fi
    else
      case "$c" in
        "'" | '"') q=$c; _inword=1 ;;
        '\') i=$((i + 1)); _word+=${s:i:1}; _inword=1 ;;
        ' ') flush_word ;;
        ';' | '&' | '|' | '(' | ')')
          if [ "${s:i+1:1}" = "$c" ]; then
            push_separator "$c$c"
            i=$((i + 1))
          else
            push_separator "$c"
          fi
          ;;
        '>' | '<')
          # `2>` — the 2 belongs to the redirection, not to rm.
          case "$_word" in *[!0-9]* | '') ;; *) _word=""; _inword=0 ;; esac
          flush_word
          while [ "${s:i+1:1}" = '>' ] || [ "${s:i+1:1}" = '&' ]; do i=$((i + 1)); done
          _skipnext=1
          ;;
        '~')
          if [ "$_inword" -eq 0 ] && [ -n "${HOME:-}" ]; then
            case "${s:i+1:1}" in
              '/' | ' ' | '' | ';' | '&' | '|') _word+="$HOME" ;;
              *) _unres=1; _word+='~' ;; # ~otheruser
            esac
          else
            _word+='~'
          fi
          _inword=1
          ;;
        '$') expand_dollar "${s:i}"; i=$((i + EXPANDED - 1)); _inword=1 ;;
        '`') _unres=1; _word+=$c; _inword=1 ;;
        '*' | '?' | '[') _glob=1; _word+=$c; _inword=1 ;;
        *) _word+=$c; _inword=1 ;;
      esac
    fi
    i=$((i + 1))
  done
  [ -n "$q" ] && _unres=1 # an unclosed quote: we can't be sure what it means
  flush_word
}

# Applies one `cd` argument to CDIR, the folder later commands run in ("" is
# the folder the command starts in). Anything we can't know in advance -
# `cd -`, `cd $DIR` - sets CD_UNKNOWN instead.
apply_cd() {
  local arg="$1" unres="$2"
  if [ "$unres" = "1" ] || [ "$arg" = "-" ]; then
    CD_UNKNOWN=1
    return 0
  fi
  case "$arg" in
    /*) CDIR="$arg" ;;
    *) CDIR="${CDIR:+$CDIR/}$arg" ;;
  esac
  return 0
}

# From WORDS, collects the arguments of every rm in the command into
# TARGETS[] (with TUNRES[] / TGLOB[] alongside) and sets RECURSIVE.
#
# It also follows `cd` (and `pushd`) through the command, so the rm in
# `cd sub && rm -rf data` is judged as sub/data: TDIR[] holds the folder each
# target is relative to, and TCDUNK[] is 1 when an earlier cd went somewhere
# only known at run time. A `( ... )` subshell's cd ends at its `)`.
collect_rm_targets() {
  local i=0 n=${#WORDS[@]} w at_start=1 in_rm=0 in_cd=0 flags_done=0
  local -a cd_stack unk_stack
  TARGETS=()
  TUNRES=()
  TGLOB=()
  TDIR=()
  TCDUNK=()
  RECURSIVE=0
  CDIR=""
  CD_UNKNOWN=0
  cd_stack=()
  unk_stack=()
  while [ "$i" -lt "$n" ]; do
    w=${WORDS[$i]}
    if [ "${WSEP[$i]}" = "1" ]; then
      # `cd` with nothing after it goes home.
      if [ "$in_cd" -eq 1 ]; then
        if [ -n "${HOME:-}" ]; then CDIR="$HOME"; else CD_UNKNOWN=1; fi
      fi
      case "$w" in
        '(')
          cd_stack+=("$CDIR")
          unk_stack+=("$CD_UNKNOWN")
          ;;
        ')')
          if [ "${#cd_stack[@]}" -gt 0 ]; then
            CDIR=${cd_stack[${#cd_stack[@]}-1]}
            CD_UNKNOWN=${unk_stack[${#unk_stack[@]}-1]}
            unset "cd_stack[${#cd_stack[@]}-1]"
            unset "unk_stack[${#unk_stack[@]}-1]"
          fi
          ;;
      esac
      at_start=1
      in_rm=0
      in_cd=0
    elif [ "$at_start" -eq 1 ]; then
      case "$w" in
        sudo | command | builtin | nice | *=*) ;; # still before the command name
        rm | */rm) in_rm=1; flags_done=0; at_start=0 ;;
        cd | pushd) in_cd=1; at_start=0 ;;
        *) at_start=0 ;;
      esac
    elif [ "$in_cd" -eq 1 ]; then
      case "$w" in
        -L | -P | -e | -@) ;; # cd's own options
        *) apply_cd "$w" "${WUNRES[$i]}"; in_cd=0 ;;
      esac
    elif [ "$in_rm" -eq 1 ]; then
      if [ "$flags_done" -eq 0 ] && [ "$w" = "--" ]; then
        flags_done=1
      elif [ "$flags_done" -eq 0 ] && [ "${WUNRES[$i]}" = "0" ] && [ "${w#-}" != "$w" ] && [ "$w" != "-" ]; then
        case "$w" in
          --recursive) RECURSIVE=1 ;;
          --*) ;;
          *[rR]*) RECURSIVE=1 ;;
        esac
      else
        TARGETS+=("$w")
        TUNRES+=("${WUNRES[$i]}")
        TGLOB+=("${WGLOB[$i]}")
        TDIR+=("$CDIR")
        TCDUNK+=("$CD_UNKNOWN")
      fi
    fi
    i=$((i + 1))
  done
  [ "$in_cd" -eq 1 ] && CD_UNKNOWN=1
  return 0
}

# Looks through WORDS for the deletes that never spell out `rm <path>`:
# `find ... -delete`, `find ... -exec rm ...`, and `... | xargs rm`. Sets
# FIND_DELETE / XARGS_RM, and FIND_ROOTS[] to the folders find starts from
# (relative ones already joined to any `cd` before them).
collect_indirect_deletes() {
  local i=0 n=${#WORDS[@]} w at_start=1 in_find=0 roots_done=0 in_xargs=0 in_cd=0 skip=0 exec_next=0
  local -a roots
  FIND_DELETE=0
  XARGS_RM=0
  FIND_ROOTS=()
  CDIR=""
  CD_UNKNOWN=0
  roots=()
  while [ "$i" -lt "$n" ]; do
    w=${WORDS[$i]}
    if [ "${WSEP[$i]}" = "1" ]; then
      if [ "$in_find" -eq 1 ] && [ "$FIND_DELETE" -eq 1 ] && [ "${#FIND_ROOTS[@]}" -eq 0 ]; then
        FIND_ROOTS=("${roots[@]}")
        [ "${#FIND_ROOTS[@]}" -eq 0 ] && FIND_ROOTS=("${CDIR:-.}")
      fi
      at_start=1; in_find=0; in_xargs=0; in_cd=0; exec_next=0
    elif [ "$at_start" -eq 1 ]; then
      case "$w" in
        sudo | command | builtin | nice | *=*) ;;
        find | */find) in_find=1; roots_done=0; roots=(); at_start=0 ;;
        xargs | */xargs) in_xargs=1; skip=0; at_start=0 ;;
        cd | pushd) in_cd=1; at_start=0 ;;
        *) at_start=0 ;;
      esac
    elif [ "$in_cd" -eq 1 ]; then
      case "$w" in -L | -P | -e | -@) ;; *) apply_cd "$w" "${WUNRES[$i]}"; in_cd=0 ;; esac
    elif [ "$in_find" -eq 1 ]; then
      if [ "$exec_next" -eq 1 ]; then
        case "$w" in rm | */rm | unlink | */unlink | shred | */shred) FIND_DELETE=1 ;; esac
        exec_next=0
      fi
      if [ "$roots_done" -eq 0 ]; then
        case "$w" in
          -* | '(' | '!') roots_done=1 ;;
          *)
            if [ "${WUNRES[$i]}" = "1" ] || [ "$CD_UNKNOWN" -eq 1 ]; then
              roots+=("?")
            else
              case "$w" in
                /*) roots+=("$w") ;;
                *) roots+=("${CDIR:+$CDIR/}$w") ;;
              esac
            fi
            ;;
        esac
      fi
      case "$w" in
        -delete) FIND_DELETE=1 ;;
        -exec | -execdir | -ok | -okdir) exec_next=1 ;;
      esac
    elif [ "$in_xargs" -eq 1 ]; then
      if [ "$skip" -eq 1 ]; then
        skip=0
      else
        case "$w" in
          -I | -n | -P | -L | -s | -d | -E | -a) skip=1 ;; # options that take a value
          -*) ;;
          sudo) ;;
          rm | */rm | unlink | */unlink | shred | */shred) XARGS_RM=1; in_xargs=0 ;;
          *) in_xargs=0 ;;
        esac
      fi
    fi
    i=$((i + 1))
  done
  if [ "$in_find" -eq 1 ] && [ "$FIND_DELETE" -eq 1 ] && [ "${#FIND_ROOTS[@]}" -eq 0 ]; then
    FIND_ROOTS=("${roots[@]}")
    [ "${#FIND_ROOTS[@]}" -eq 0 ] && FIND_ROOTS=("${CDIR:-.}")
  fi
  return 0
}

# True for the targets that wipe a disk or a whole home folder.
is_catastrophic_target() {
  local t="$1"
  while [ "${#t}" -gt 1 ] && [ "${t%/}" != "$t" ]; do t=${t%/}; done
  case "$t" in
    / | /\* | .. | ../\*) return 0 ;;
  esac
  if [ -n "${HOME:-}" ]; then
    local h="${HOME%/}"
    [ "$t" = "$h" ] || [ "$t" = "$h/*" ] && return 0
  fi
  return 1
}

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

# Words that run the next word as the command: `command rm`, `env X=1 rm`,
# `nice -n 5 rm`, `timeout 5 rm`, `sudo rm`, `\rm`. Each is dropped from the
# start of a command, so the checks below see the rm (or git) they run.
# Repeated until nothing changes, for `sudo nice rm`.
V='[^ ;&|]'
WRAPPER="command( +-p)*|builtin|nohup|exec( +-[cl]+)*|time( +-p)?"
WRAPPER="$WRAPPER|env( +(-[iv0]+|-u +$V+|--[a-z-]+(=$V+)?|[A-Za-z_][A-Za-z0-9_]*=$V*))*"
WRAPPER="$WRAPPER|nice( +(-n +-?[0-9]+|-n?-?[0-9]+|--adjustment=-?[0-9]+))*"
WRAPPER="$WRAPPER|timeout( +(-[sk] +[^ ;&|-]$V*|-[a-zA-Z]+|--[a-z-]+(=$V+)?))* +[0-9.]+[smhd]?"
WRAPPER="$WRAPPER|sudo( +(-[ugCDhpRrTt] +[^ ;&|-]$V*|-[a-zA-Z]+|--[a-z-]+(=$V+)?))*"
WRAPPER="$WRAPPER|[A-Za-z_][A-Za-z0-9_]*=$V*"
CMD=$(printf '%s\n' "$CMD" | sed -E \
  -e ':a' \
  -e "s/(^|[;&|(] *)\\\\([A-Za-z])/\\1\\2/g" \
  -e "s/(^|[;&|(] *)($WRAPPER) +/\\1/g" \
  -e 'ta')

# The same command, one simple command per line: split at ; & | and ( ),
# and with git's own options (`git -C dir`, `git -c k=v`) taken out so
# `git -C . reset --hard` reads as `git reset --hard`. GIT_DIR_ARG keeps the
# -C folder, since that is where the work would be lost.
SEGMENTS=$(printf '%s\n' "$CMD" | tr ';&|()' '\n\n\n\n\n' | sed -E -e 's/^ +//' -e 's/ +$//')
GIT_DIR_ARG=$(printf '%s\n' "$SEGMENTS" \
  | sed -nE "s/^git( +(-c +$V+|--[a-z-]+(=$V+)?|-[pP]))* +-C +($V+).*/\\4/p" | head -n 1)
GIT_DIR_ARG=${GIT_DIR_ARG#[\"\']}
GIT_DIR_ARG=${GIT_DIR_ARG%[\"\']}
[ -n "$GIT_DIR_ARG" ] || GIT_DIR_ARG="."
SEGMENTS=$(printf '%s\n' "$SEGMENTS" | sed -E \
  -e ':g' \
  -e "s/^git +(-[cC] +$V+|--(git-dir|work-tree|namespace|exec-path)(=$V+)?|--no-pager|--paginate|-[pP]|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks) +/git /" \
  -e 'tg')

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

# --- Git ----------------------------------------------------------------------
# Sorts one simple command (from SEGMENTS) into what it would lose, in GK:
#   discard  throws away uncommitted edits (reset --hard, clean -f,
#            checkout -- / . / -f, restore, switch -f)
#   stash    drops work put aside with git stash
#   branch   deletes a branch whether or not it was merged
#   force    overwrites the remote branch; lease does so more carefully
# Bash 3.2 reads a regex from a variable reliably, so each one is kept in one.
RE_FORCE_SHORT=' -[a-zA-Z]*f[a-zA-Z]* '
RE_DRY_RUN=' (--dry-run|-[a-zA-Z]*n[a-zA-Z]*) '
RE_WORKTREE=' (--worktree|-[a-zA-Z]*W[a-zA-Z]*) '
RE_STAGED=' (--staged|-[a-zA-Z]*S[a-zA-Z]*) '
RE_BRANCH_D=' -[a-zA-Z]*D[a-zA-Z]* '
RE_BRANCH_DEL=' (--delete|-[a-zA-Z]*d[a-zA-Z]*) '
RE_PLUS_REFSPEC=' \+[^ ]'
classify_git() {
  local s=" $1 "
  GK=""
  case "$s" in
    " git reset "*) case "$s" in *" --hard "*) GK="discard" ;; esac ;;
    " git clean "*)
      if { [[ $s == *" --force "* ]] || [[ $s =~ $RE_FORCE_SHORT ]]; } && ! [[ $s =~ $RE_DRY_RUN ]]; then
        GK="discard"
      fi
      ;;
    " git checkout "*)
      case "$s" in
        *" -- "* | *" . "* | *" ./ "* | *" :/ "* | *" --force "*) GK="discard" ;;
        *) [[ $s =~ $RE_FORCE_SHORT ]] && GK="discard" ;;
      esac
      ;;
    " git restore "*)
      # Without --staged it puts the working copy back, losing the edits.
      if [[ $s =~ $RE_WORKTREE ]] || ! [[ $s =~ $RE_STAGED ]]; then GK="discard"; fi
      ;;
    " git switch "*)
      case "$s" in
        *" --force "* | *" --discard-changes "*) GK="discard" ;;
        *) [[ $s =~ $RE_FORCE_SHORT ]] && GK="discard" ;;
      esac
      ;;
    " git stash drop "* | " git stash clear "*) GK="stash" ;;
    " git branch "*)
      if [[ $s =~ $RE_BRANCH_D ]]; then
        GK="branch"
      elif [[ $s =~ $RE_BRANCH_DEL ]] && { [[ $s == *" --force "* ]] || [[ $s =~ $RE_FORCE_SHORT ]]; }; then
        GK="branch"
      fi
      ;;
    " git push "*)
      case "$s" in
        *" --force-with-lease"* | *" --force-if-includes "*) GK="lease" ;;
        *" --force "* | *" --mirror "*) GK="force" ;;
        *)
          if [[ $s =~ $RE_FORCE_SHORT ]] || [[ $s =~ $RE_PLUS_REFSPEC ]]; then GK="force"; fi
          ;;
      esac
      ;;
  esac
  return 0
}

GIT_DISCARD=0
GIT_STASH=0
GIT_BRANCH=0
GIT_FORCE=""
case "$CMD" in
  *git*)
    while IFS= read -r seg; do
      classify_git "$seg"
      case "$GK" in
        discard) GIT_DISCARD=1 ;;
        stash) GIT_STASH=1 ;;
        branch) GIT_BRANCH=1 ;;
        force) GIT_FORCE="force" ;;
        lease) [ -n "$GIT_FORCE" ] || GIT_FORCE="lease" ;;
      esac
    done <<EOF_SEGMENTS
$SEGMENTS
EOF_SEGMENTS
    ;;
esac

if [ "$GIT_DISCARD" -eq 1 ]; then
  UNSAVED=$(count_unsaved "$GIT_DIR_ARG" | head -n 1)
  if [ "$UNSAVED" = "unknown" ]; then
    respond_ask \
      "This throws away any changes you haven't committed." \
      "Git didn't answer in time, so it's unclear whether there are any."
  fi
  if [ "$UNSAVED" -gt 0 ] 2>/dev/null; then
    respond_ask \
      "This throws away your uncommitted changes." \
      "$UNSAVED $(plural "$UNSAVED" "file has" "files have") edits that aren't saved in git yet." \
      "loud"
  fi
  # Nothing uncommitted means nothing to lose, and outside a repo the command
  # just fails. Carry on: the rest of the command may still delete something.
fi

case "$GIT_FORCE" in
  lease)
    respond_ask "This rewrites the shared history on the branch you're pushing to." \
                "Teammates who already pulled it will hit conflicts." ;;
  force)
    respond_ask "This overwrites the shared branch with your local version." \
                "Anything a teammate pushed that you don't have locally is lost." "loud" ;;
esac

if [ "$GIT_STASH" -eq 1 ]; then
  respond_ask \
    "This permanently deletes work that was put aside with git stash." \
    "Once dropped, it can't be got back with an ordinary git command."
fi

if [ "$GIT_BRANCH" -eq 1 ]; then
  respond_ask \
    "This deletes a branch even if its work was never merged anywhere." \
    "Commits that only that branch has become very hard to get back."
fi

# --- Other ways to delete or empty files ------------------------------------
# unlink removes one file; rsync --delete removes whatever the destination
# has that the source doesn't; truncate -s 0 empties a file in place.
OTHER_KIND=""
case "$CMD" in
  *unlink* | *rsync* | *truncate*)
    while IFS= read -r seg; do
      oseg=" $seg "
      case "$oseg" in
        " unlink "* | " "*/unlink" "*) OTHER_KIND="unlink" ;;
        " rsync "* | " "*/rsync" "*)
          case "$oseg" in *" --del "* | *" --delete"*) OTHER_KIND="rsync" ;; esac ;;
        " truncate "* | " "*/truncate" "*)
          case "$oseg" in
            *" -s 0 "* | *" -s0 "* | *" --size=0 "* | *" --size 0 "*) OTHER_KIND="truncate" ;;
          esac
          ;;
      esac
      [ -n "$OTHER_KIND" ] && break
    done <<EOF_SEGMENTS
$SEGMENTS
EOF_SEGMENTS
    ;;
esac
case "$OTHER_KIND" in
  unlink)
    respond_ask "This deletes a file outright." \
                "Make sure it's the file you mean before saying yes." ;;
  rsync)
    respond_ask "This deletes any file in the destination that the source doesn't have." \
                "Check the two folders are the right way round before saying yes." ;;
  truncate)
    respond_ask "This empties a file, keeping its name but throwing away everything in it." \
                "There's no undo for this." ;;
esac

# --- find -delete, find -exec rm, xargs rm ----------------------------------
# These delete a list of files that only exists when the command runs, so we
# can't count it. Ask, unless find is only clearing build output.
if printf '%s' "$CMD" | grep -qE '(^|[;&|(] *)(sudo +)?([^ ;&|]*/)?(find|xargs)( |$)'; then
  if [ "${#CMD}" -gt "$MAX_PARSE_CHARS" ]; then
    if printf '%s' "$CMD" | grep -qE ' -delete( |$)| -(exec|execdir|ok|okdir) +([^ ]*/)?(rm|unlink|shred)( |$)|xargs .*([^ ]*/)?(rm|unlink|shred)( |$)'; then
      respond_ask \
        "This deletes files from a command too long to check here." \
        "Have a look at what it removes before saying yes."
    fi
  else
    tokenize "$CMD"
    collect_indirect_deletes
    if [ "$XARGS_RM" -eq 1 ]; then
      respond_ask \
        "This deletes whatever list of files is piped into it." \
        "That list only exists when the command runs, so check what produces it before saying yes."
    fi
    if [ "$FIND_DELETE" -eq 1 ]; then
      ROUTINE=1
      for p in "${FIND_ROOTS[@]}"; do
        if [ "$p" = "?" ] || { ! is_ignorable_path "$p" && ! is_git_ignored "$p"; }; then
          ROUTINE=0
          break
        fi
      done
      if [ "$ROUTINE" -eq 0 ]; then
        respond_ask \
          "This deletes every file that find matches, which can't be counted ahead of time." \
          "Run the same find without the delete part first to see what it would remove."
      fi
    fi
  fi
fi

# --- rm ---------------------------------------------------------------------
if printf '%s' "$CMD" | grep -qE '(^|[;&|(] *)(sudo +)?([^ ;&|]*/)?rm( |$)'; then

  # Catastrophic targets first: these are never a good idea.
  if printf '%s' "$CMD" | grep -qE 'rm +(-[a-zA-Z]+ +)*(/|~|/\*|~/\*|\$HOME|\.\.)( |$|/\*)'; then
    respond_ask \
      "This tries to delete your whole home folder or the whole disk." \
      "That is almost certainly not what was meant." \
      "loud"
  fi

  # Reading a command character by character is slow in bash. Past this
  # length, a recursive delete gets a plain question instead of a guess.
  if [ "${#CMD}" -gt "$MAX_PARSE_CHARS" ]; then
    if printf '%s' "$CMD" | grep -qE 'rm +(-[a-zA-Z]*[rR][a-zA-Z]* +)'; then
      respond_ask \
        "This deletes folders from a command too long to check here." \
        "Have a look at what it removes before saying yes."
    fi
    exit 0
  fi

  tokenize "$CMD"
  collect_rm_targets
  [ "${#TARGETS[@]}" -eq 0 ] && exit 0

  # Turn each target into real paths: globs are expanded here, in the same
  # directory the command will run in.
  PATHS=()
  UNRESOLVED=0
  CD_UNRESOLVED=0
  i=0
  while [ "$i" -lt "${#TARGETS[@]}" ]; do
    t=${TARGETS[$i]}
    # A relative path after a `cd` means a path inside that folder.
    case "$t" in
      /*) ;;
      *)
        if [ "${TCDUNK[$i]}" = "1" ]; then
          CD_UNRESOLVED=1
          i=$((i + 1))
          continue
        fi
        [ -n "${TDIR[$i]}" ] && t="${TDIR[$i]%/}/$t"
        ;;
    esac
    if [ "${TUNRES[$i]}" = "1" ]; then
      UNRESOLVED=1
    else
      if is_catastrophic_target "$t" || is_catastrophic_target "${TARGETS[$i]}"; then
        respond_ask \
          "This tries to delete your whole home folder or the whole disk." \
          "That is almost certainly not what was meant." \
          "loud"
      fi
      if [ "${TGLOB[$i]}" = "1" ]; then
        while IFS= read -r match; do
          [ -n "$match" ] && PATHS+=("$match")
        done <<EOF_GLOB
$(compgen -G "$t" 2>/dev/null | head -n "$FIND_LIMIT")
EOF_GLOB
      else
        PATHS+=("$t")
      fi
    fi
    i=$((i + 1))
  done

  # A recursive delete of something only known at run time — `rm -rf $DIR`,
  # `rm -rf "$(pwd)"` — can't be judged here. Saying nothing would treat
  # "don't know" as "safe", so ask.
  if [ "$UNRESOLVED" -eq 1 ] && [ "$RECURSIVE" -eq 1 ]; then
    respond_ask \
      "This deletes a folder whose name is only filled in when the command runs." \
      "Make sure you know where it points before saying yes."
  fi

  # Same for a recursive delete after a `cd` we can't follow: we don't know
  # which folder the path is inside.
  if [ "$CD_UNRESOLVED" -eq 1 ] && [ "$RECURSIVE" -eq 1 ]; then
    respond_ask \
      "This deletes a folder after moving into a directory that's only known when the command runs." \
      "Make sure you know which folder it ends up in before saying yes."
  fi

  COUNT=${#PATHS[@]}
  [ "$COUNT" -eq 0 ] && exit 0

  # Every path is build output or already git-ignored → routine cleanup.
  ALL_IGNORABLE=1
  for p in "${PATHS[@]}"; do
    if ! is_ignorable_path "$p" && ! is_git_ignored "$p"; then
      ALL_IGNORABLE=0
      break
    fi
  done
  [ "$ALL_IGNORABLE" -eq 1 ] && exit 0

  # A bare glob, a recursive delete, or a bulk list is worth a look.
  BARE_GLOB=0
  printf '%s' "$CMD" | grep -qE 'rm +(-[a-zA-Z]+ +)*\*' && BARE_GLOB=1

  if [ "$RECURSIVE" -eq 0 ] && [ "$BARE_GLOB" -eq 0 ] && [ "$COUNT" -le 5 ]; then
    exit 0
  fi

  # Count what actually disappears, and how much of it isn't saved in git.
  TOTAL=0
  EXISTING=()
  for p in "${PATHS[@]}"; do
    n=$(count_files "$p")
    if [ "$n" -gt 0 ] 2>/dev/null; then
      TOTAL=$((TOTAL + n))
      EXISTING+=("$p")
    fi
  done
  [ "$TOTAL" -eq 0 ] && exit 0

  UNSAVED_OUT=$(count_unsaved "${EXISTING[@]}")
  UNSAVED=${UNSAVED_OUT%%
*}
  FILES="$TOTAL $(plural "$TOTAL" "file" "files")"

  # Files git ignores (a .env, local config, keys) are never in git, however
  # clean the rest of the folder is. Build output is ignored too, but can be
  # rebuilt, so it only softens the reassurance below.
  IGNORED_LIST=""
  [ "$UNSAVED" = "$UNSAVED_OUT" ] || IGNORED_LIST=${UNSAVED_OUT#*
}
  IGNORED=$(printf '%s\n' "$IGNORED_LIST" | grep -v '^build:' | grep -c .) || true
  BUILD_IGNORED=$(printf '%s\n' "$IGNORED_LIST" | grep -c '^build:') || true
  IGNORED_EXAMPLE=$(printf '%s\n' "$IGNORED_LIST" | grep -v '^build:' | grep . | head -n 1)
  IGNORED_EXAMPLE=${IGNORED_EXAMPLE##*/}

  # Reaching here means the delete is recursive, uses a bare glob, or names
  # more than five paths — all of which §9.5 asks us to surface. The only
  # question left is how alarming the message should be.
  case "$UNSAVED" in
    nogit)
      respond_ask \
        "This deletes $FILES and can't be undone." \
        "$(plural "$TOTAL" "It isn't" "They aren't") saved in git, so there is no copy to get back." \
        "loud"
      ;;
    unknown)
      respond_ask \
        "This deletes $FILES and can't be undone." \
        "Git couldn't confirm a saved copy exists, so assume there isn't one." \
        "loud"
      ;;
  esac

  IGNORED_SAY=""
  if [ "$IGNORED" -gt 0 ] 2>/dev/null; then
    IGNORED_SAY="Git ignores $IGNORED $(plural "$IGNORED" "item" "items") in it (like $IGNORED_EXAMPLE), so it has no copy of $(plural "$IGNORED" "that" "those")."
  fi

  if [ "$UNSAVED" -gt 0 ] 2>/dev/null; then
    respond_ask \
      "This deletes $FILES and can't be undone." \
      "$UNSAVED of them $(plural "$UNSAVED" "has" "have") changes that aren't saved in git.${IGNORED_SAY:+ $IGNORED_SAY}" \
      "loud"
  fi

  if [ -n "$IGNORED_SAY" ]; then
    respond_ask \
      "This deletes $FILES and can't be undone." \
      "$IGNORED_SAY" \
      "loud"
  fi

  # Only now, with git having answered and found nothing unsaved or ignored,
  # is it true to say the files can be got back.
  SAVED="All of it is saved in git, so you could get it back."
  if [ "$BUILD_IGNORED" -gt 0 ] 2>/dev/null; then
    SAVED="Apart from build output that can be rebuilt, all of it is saved in git, so you could get it back."
  fi

  if [ "$COUNT" -gt 5 ]; then
    respond_ask \
      "This deletes $FILES across $COUNT places at once." \
      "$SAVED"
  fi

  respond_ask \
    "This deletes $FILES." \
    "$SAVED"
fi

# --- Deleting credentials by any other means --------------------------------
if printf '%s' "$CMD" | grep -qE '(rm|shred|mv) +.*(\.env|\.pem|\.key|id_rsa|id_ed25519|credentials)( |$)'; then
  respond_ask \
    "This removes a file that stores your passwords or keys." \
    "If it isn't backed up somewhere else, it's gone for good." \
    "loud"
fi

exit 0
