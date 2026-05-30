#!/usr/bin/env bash
# UserPromptSubmit hook: reap THIS session's leftover panes from a previous turn
# whose subagent was interrupted (no SubagentStop fired). Scoped to this
# session's anchor so it never touches another concurrent session's panes.
# Always exits 0.

# iTerm2 is macOS-only; no-op on any other platform.
case "$OSTYPE" in
  darwin*) ;;
  *) exit 0 ;;
esac

DATA="$CLAUDE_PLUGIN_DATA"
PY="$DATA/venv/bin/python"

cat >/dev/null  # drain stdin payload (unused)
anchor_id="${ITERM_SESSION_ID##*:}"
printf '%s REAP anchor=%s\n' "$(date '+%H:%M:%S')" "${anchor_id:0:8}" >> "$DATA/debug.log"

"$PY" "$CLAUDE_PLUGIN_ROOT/scripts/monitor.py" reap "$anchor_id" >> "$DATA/debug.log" 2>&1
exit 0
