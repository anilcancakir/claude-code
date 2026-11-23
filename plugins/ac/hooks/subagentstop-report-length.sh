#!/bin/sh
# SubagentStop guard: bounce an over-length ac:explore or ac:librarian report once.
#
# Why. A subagent's final report enters the orchestrator's context and is re-read on every later
# turn. Measured 2026-11-17..23: explore reports median ~7 KB against a body cap of 500 words,
# librarian ~8.5 KB against 700; Haiku 5.5 does not hold a cap stated in one sentence. The caps,
# 900 words (explore) and 1200 (librarian), sit near the measured medians, so about half of the
# runs get one rewrite turn; a live 2.1.330 run went from 2,951 words to 630 with all 57 anchors kept.
#
# Opt-out. A brief whose output is one row per item and must not be merged (the `/ac:init-project`
# audit) carries the line `REPORT-LENGTH: unbounded`; the hook finds it in the first user message
# of the agent's transcript and lets the report through.
#
# Bounds. Blocks at most once per agent_id: the `stop_hook_active` flag and a marker under TMPDIR
# both enforce that. Every other condition fails OPEN (exit 0, no output): a missing jq, an
# unreadable payload, an unwritable marker.

set -u

# 0. Read the payload. jq is the only parser; without it we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Scope. A main-thread stop carries no agent_type, which is what leaves the orchestrator alone.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
case "$agent_type" in
    ac:explore | explore) cap=900 ;;
    ac:librarian | librarian) cap=1200 ;;
    *) exit 0 ;;
esac

agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)"
[ -n "$agent_id" ] || exit 0
case "$agent_id" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)"
[ "$active" = "true" ] && exit 0

# 2. The once-per-agent marker, under TMPDIR keyed by the agent id (never the user's repository).
dir="${TMPDIR:-/tmp}/ac-report-length"
[ -L "$dir" ] && exit 0
mkdir -p "$dir" 2>/dev/null || exit 0
[ -O "$dir" ] || exit 0
find "$dir" -type f -mtime +1 -delete 2>/dev/null
marker="$dir/$agent_id"
[ -e "$marker" ] && exit 0

# 3. Count the words of the last message. No message, or one within the cap, is nothing to judge.
message="$(printf '%s' "$input" | jq -r '.last_assistant_message | strings' 2>/dev/null)" || exit 0
[ -n "$message" ] || exit 0
words="$(printf '%s' "$message" | wc -w | tr -d ' ')"
case "$words" in '' | *[!0-9]*) exit 0 ;; esac
[ "$words" -gt "$cap" ] || exit 0

# The opt-out lives in the brief, which is the transcript's first user record. -R with fromjson?
# skips a torn line; an unreadable transcript means no opt-out was seen, so the cap applies.
transcript="$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null)"
if [ -n "$transcript" ] && [ -r "$transcript" ]; then
    brief="$(jq -n -R -r '
        first(inputs | fromjson? | objects | select(.type == "user") | .message | objects | .content
            | if type == "string" then . else ([arrays | .[] | objects | .text | strings] | join("\n")) end)
    ' "$transcript" 2>/dev/null)"
    case "$brief" in *"REPORT-LENGTH: unbounded"*) exit 0 ;; esac
fi

reason="Your final report is $words words and the cap is $cap. Rewrite the complete final report under $cap words"
reason="$reason as your last message: keep every file_path:line_number anchor or URL citation and the section"
reason="$reason headings, merge rows, and drop narration and restated context. The orchestrator receives that"
reason="$reason last message alone, so it must be the whole report, not a note about the rewrite. If another"
reason="$reason instruction asks you to repeat the report, repeat it under the cap."

# 4. Record the block before emitting it. A marker we cannot persist would block again on the next
#    stop, so failing open is the honest direction.
: > "$marker" 2>/dev/null || exit 0
jq -cn --arg r "$reason" '{decision: "block", reason: $r}'
exit 0
