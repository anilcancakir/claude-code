#!/usr/bin/env bash
# SubagentStart hook: open an iTerm2 monitor pane for the starting subagent.
# Always exits 0 so it never interferes with subagent creation.

# iTerm2 is macOS-only; no-op on any other platform.
case "$OSTYPE" in
  darwin*) ;;
  *) exit 0 ;;
esac

DATA="$CLAUDE_PLUGIN_DATA"
PY="$DATA/venv/bin/python"
JQ="$(command -v jq || echo /usr/bin/jq)"

payload="$(cat)"
printf '%s START %s\n' "$(date '+%H:%M:%S')" "$payload" >> "$DATA/debug.log"

agent_id="$(printf '%s' "$payload" | "$JQ" -r '.agent_id // .agentId // empty' 2>/dev/null)"
agent_type="$(printf '%s' "$payload" | "$JQ" -r '.agent_type // .agentType // .subagent_type // .agent.type // "agent"' 2>/dev/null)"

if [ -z "$agent_id" ]; then
  printf '%s START skipped: no agent_id\n' "$(date '+%H:%M:%S')" >> "$DATA/debug.log"
  exit 0
fi
[ -z "$agent_type" ] && agent_type="agent"

# The claude pane's iTerm2 session GUID is the part after the colon in
# ITERM_SESSION_ID (e.g. "w0t2p0:GUID" -> "GUID"). Inherited from the claude
# process. Empty when not running under iTerm2 -> monitor.py falls back to a window.
anchor_id="${ITERM_SESSION_ID##*:}"

# Derive the subagent transcript path from the parent transcript_path so the
# pane can tail it directly instead of scanning all of ~/.claude/projects.
# parent: <proj>/<session>.jsonl  ->  subagent: <proj>/<session>/subagents/agent-<id>.jsonl
parent_tp="$(printf '%s' "$payload" | "$JQ" -r '.transcript_path // empty' 2>/dev/null)"
sub_path="-"
[ -n "$parent_tp" ] && sub_path="${parent_tp%.jsonl}/subagents/agent-${agent_id}.jsonl"

"$PY" "$CLAUDE_PLUGIN_ROOT/scripts/monitor.py" open "$agent_id" "$agent_type" "$anchor_id" "$sub_path" >> "$DATA/debug.log" 2>&1
exit 0
