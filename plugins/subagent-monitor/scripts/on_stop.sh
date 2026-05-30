#!/usr/bin/env bash
# SubagentStop hook: signal the pane to show "✓ done", then close it after a
# short linger so fast subagents stay readable. Returns immediately (the close
# runs detached). Always exits 0.

# iTerm2 is macOS-only; no-op on any other platform.
case "$OSTYPE" in
  darwin*) ;;
  *) exit 0 ;;
esac

DATA="$CLAUDE_PLUGIN_DATA"
PY="$DATA/venv/bin/python"
JQ="$(command -v jq || echo /usr/bin/jq)"
LINGER=4

payload="$(cat)"
printf '%s STOP %s\n' "$(date '+%H:%M:%S')" "$payload" >> "$DATA/debug.log"

agent_id="$(printf '%s' "$payload" | "$JQ" -r '.agent_id // .agentId // empty' 2>/dev/null)"

if [ -z "$agent_id" ]; then
  printf '%s STOP skipped: no agent_id\n' "$(date '+%H:%M:%S')" >> "$DATA/debug.log"
  exit 0
fi

# Signal the pane to render "✓ done" right away.
mkdir -p "$DATA/done"
touch "$DATA/done/$agent_id"

# Close the pane after the linger window, detached so the hook does not block.
nohup bash -c "sleep $LINGER; '$PY' '$CLAUDE_PLUGIN_ROOT/scripts/monitor.py' close '$agent_id' >> '$DATA/debug.log' 2>&1" \
  >/dev/null 2>&1 &
exit 0
