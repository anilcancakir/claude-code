#!/bin/sh
# SubagentStop guard: block once while a background task the subagent itself started still runs.
#
# Why. Measured on Claude Code 2.1.302: a background subagent that leaves a background shell
# running parks after its final report ("is waiting on its own background work") and only wakes
# when that shell ends, so the orchestrator waits on a run that already finished its work. The
# SubagentStop event fires before the park, and `decision: "block"` with a `reason` keeps the
# subagent running and delivers the reason as its next instruction, so the block lands in time.
#
# Whose task is it. `background_tasks` in a SubagentStop payload is scoped to the parent session,
# not the subagent, so a running id alone proves nothing: the orchestrator's dev server and a
# sibling agent's test run are in the same list. The guard intersects it with the ids this
# agent's own transcript records. Confirmed against real transcripts (2026-10-17): a Bash that
# outgrew its timeout carries `toolUseResult.backgroundTaskId` and the text "moved to the
# background (ID: <id>)" in its tool_result; a Monitor carries `toolUseResult.taskId` and
# "Monitor started (task <id>". `toolUseResult` is an object on most records and a plain string
# on some, hence the `objects` and `strings` guards in the filter. The task `type` is not
# filtered: only `shell` is confirmed in the research, so any running own id counts.
#
# Scope and bounds. It acts on ac agents only (`ac:<name>`, or one of the eleven bare names for an
# agent installed unprefixed), never on the main thread, and blocks at most once per agent_id:
# the `stop_hook_active` flag and a marker under TMPDIR both enforce that, so a subagent that
# ignores the instruction is let through on its next stop instead of looping. Every other
# condition fails OPEN (exit 0, no output): a missing jq, a payload or transcript it cannot read,
# and an unwritable marker.

set -u

# 0. Read the payload. jq is the only parser; without it we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Scope. A main-thread stop carries no agent_type, which is what leaves the orchestrator alone.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
case "$agent_type" in
    ac:* | explore | librarian | oracle | plan-worker-quick | plan-worker-junior | plan-worker-junior-high \
        | plan-worker-senior | plan-reviewer | plan-code-review | auto-verifier | qa-tester) ;;
    *) exit 0 ;;
esac

agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)"
[ -n "$agent_id" ] || exit 0
case "$agent_id" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)"
[ "$active" = "true" ] && exit 0

# 2. The once-per-agent marker, under TMPDIR keyed by the agent id (never the user's repository).
dir="${TMPDIR:-/tmp}/ac-subagent-stop"
[ -L "$dir" ] && exit 0
mkdir -p "$dir" 2>/dev/null || exit 0
[ -O "$dir" ] || exit 0
find "$dir" -type f -mtime +1 -delete 2>/dev/null
marker="$dir/$agent_id"
[ -e "$marker" ] && exit 0

# 3. Running ids in the session, and the ids this agent started. Nothing running, or no
#    transcript to read, means there is nothing to judge.
transcript="$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null)"
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0
printf '%s' "$input" | jq -e '[.background_tasks | arrays | .[] | objects | select(.status == "running")] | length > 0' \
    >/dev/null 2>&1 || exit 0

# -R with fromjson? skips a torn line instead of failing the whole read.
own="$(jq -R -r '
    def id: "[A-Za-z0-9_-]+";
    def spotted: scan("running in background with ID: (" + id + ")"
        + "|moved to the background \\(ID: (" + id + ")\\)"
        + "|manually backgrounded by user with ID: (" + id + ")"
        + "|Monitor started \\(task (" + id + ")") | .[] | select(. != null);
    fromjson? | objects
    | (.toolUseResult | objects | (.backgroundTaskId, .taskId) | strings),
      (.toolUseResult | strings | spotted),
      (select(.type == "user") | .message | objects | .content | arrays | .[] | objects
        | select(.type == "tool_result") | .content
        | if type == "string" then . else (arrays | .[] | objects | .text | strings) end
        | spotted)
' "$transcript" 2>/dev/null)" || exit 0
[ -n "$own" ] || exit 0

reason="$(printf '%s' "$input" | jq -r --arg own "$own" '
    ($own | split("\n")) as $mine
    | [.background_tasks[] | objects | select(.status == "running" and (.id | IN($mine[])))]
    | if length == 0 then empty else
        "Background work you started is still running, and a parked subagent leaves the orchestrator waiting on it:\n"
        + (map("- " + .id + ": " + ((.command // .description // "no command recorded") | gsub("\\s+"; " ") | .[0:200]))
            | join("\n"))
        + "\n\nStop each one with TaskStop unless your briefing names it as one to keep. Report a stopped run as"
        + " not completed, with the exact command to rerun it. Then repeat your complete final report as your"
        + " last message: it replaces the one above."
      end
' 2>/dev/null)" || exit 0
[ -n "$reason" ] || exit 0

# 4. Record the block before emitting it. A marker we cannot persist would block again on the next
#    stop, so failing open is the honest direction.
: > "$marker" 2>/dev/null || exit 0
jq -cn --arg r "$reason" '{decision: "block", reason: $r}'
exit 0
