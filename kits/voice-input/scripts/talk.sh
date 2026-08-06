#!/usr/bin/env bash
#
# ccpanel — talk instead of typing
#
# Toggles dictation on and off. While it is on, whatever you say is typed
# wherever your cursor already is, so it lands in Claude Code's prompt box the
# same way your keyboard would.
#
# Everything runs on your own computer. No audio leaves the machine, nothing is
# sent to a server, and it costs nothing to use.

set -u
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/ccpanel-voice"
mkdir -p "$STATE_DIR" 2>/dev/null

say() { printf '%s\n' "$1"; }

# ---------------------------------------------------------------------------
# Check the one-time setup before doing anything, and say plainly what is
# missing rather than failing with a stack trace.
# ---------------------------------------------------------------------------
check_setup() {
  local missing=0

  if ! command -v nerd-dictation >/dev/null 2>&1; then
    say "Dictation isn't installed on this computer yet."
    say ""
    say "To install it, run these two lines in your terminal:"
    say "  git clone https://github.com/ideasman42/nerd-dictation.git ~/.local/share/nerd-dictation"
    say "  ln -s ~/.local/share/nerd-dictation/nerd-dictation ~/.local/bin/nerd-dictation"
    say ""
    say "You'll also need a voice model, once:"
    say "  https://alphacephei.com/vosk/models  (the small English one is enough)"
    say "  Unzip it to ~/.config/nerd-dictation/model"
    missing=1
  fi

  # Something has to do the actual typing. Which one depends on the display.
  if ! command -v xdotool >/dev/null 2>&1 \
     && ! command -v ydotool >/dev/null 2>&1 \
     && ! command -v wtype  >/dev/null 2>&1 \
     && ! command -v dotool >/dev/null 2>&1; then
    say ""
    if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
      say "One more piece is missing — the part that types for you:"
      say "  sudo apt install wtype     (or: ydotool)"
    else
      say "One more piece is missing — the part that types for you:"
      say "  sudo apt install xdotool"
    fi
    missing=1
  fi

  if [ ! -d "${HOME}/.config/nerd-dictation/model" ] && command -v nerd-dictation >/dev/null 2>&1; then
    say ""
    say "The voice model isn't in place yet. Download the small English model from"
    say "  https://alphacephei.com/vosk/models"
    say "and unzip it to ~/.config/nerd-dictation/model"
    missing=1
  fi

  return $missing
}

case "${1:-toggle}" in
  check)
    if check_setup; then
      say "You're all set. Run this with no arguments to start talking."
      exit 0
    fi
    exit 1
    ;;

  start)
    check_setup || exit 1
    nerd-dictation begin --continuous >/dev/null 2>&1 &
    say "Listening. Say your prompt, then run this again to stop."
    ;;

  stop)
    nerd-dictation end >/dev/null 2>&1
    say "Stopped listening."
    ;;

  toggle | "")
    check_setup || exit 1
    if pgrep -f "nerd-dictation begin" >/dev/null 2>&1; then
      nerd-dictation end >/dev/null 2>&1
      say "Stopped listening."
    else
      nerd-dictation begin --continuous >/dev/null 2>&1 &
      say "Listening. Say your prompt, then run this again to stop."
    fi
    ;;

  *)
    say "Use: talk.sh [check|start|stop|toggle]"
    exit 1
    ;;
esac
