#!/bin/sh
# Call budget for ac:explore.
#
# Denies further tool calls once one explore spawn has made more than the budget, and tells it
# to report what it already has. Every other condition fails OPEN (exit 0, no output): a payload
# it cannot parse, a call from the main thread or from any other agent, a missing jq, an
# unwritable counter, and any parse uncertainty.
#
# Why a hook and not a sentence in the agent body. Measured across 309 real runs, ac:explore
# averages 36.6 tool calls and peaks at 183, while its own body asks for "two to three parallel
# passes" and "under 500 words total". Its sibling ac:librarian carries the same shape of
# instruction and lands inside its budget. Same author, same phrasing, different model: prose
# numbers bind on Sonnet and do not bind on Haiku, so the bound for this agent has to sit
# outside its token stream.
#
# Why agent_type rather than the agent's own frontmatter. Two frontmatter mechanisms were tested
# on 2.1.259 and neither works: `maxTurns: 3` did not bind (61 turns observed), and a `hooks:`
# block in an agent's frontmatter never fired (0 invocations, 0 payloads). What does work is this:
# a plugin-level hook receives `agent_type` and `agent_id` when it fires inside a subagent, and
# receives neither on the main thread. Measured directly, one probe run:
#   agent_type=namedprobe agent_id=yes   <- inside the subagent
#   agent_type=ABSENT     agent_id=no    <- main thread
#
# The budget is calibrated on the tail, not the mean. At 60 it never fires on a median run and
# cuts the 183-call outlier. It is a circuit breaker, not a target, and the agent is told to
# report rather than to stop dead, so a tripped budget still returns usable work.

set -u

max_calls="${AC_EXPLORE_MAX_CALLS:-60}"
case "$max_calls" in
    '' | *[!0-9]*) max_calls=60 ;;
esac

# 0. Read the payload. jq is the only parser; without either we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Scope. This hook governs one agent and nothing else. A main-thread call carries no
#    agent_type at all, so the absence check below is what keeps the orchestrator unaffected.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
[ "$agent_type" = "explore" ] || exit 0

agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)"
[ -n "$agent_id" ] || exit 0

# 2. Resolve a tree to keep the counter in. Unlike the marker-reading hooks there is nothing to
#    probe for, so take the payload cwd and fall back.
payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
project_dir="${payload_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"
dir="$project_dir/.ac/state/agent-budget"
mkdir -p "$dir" 2>/dev/null || exit 0

# 3. Sweep counters older than a day. Self-cleaning, because nothing else deletes these and a
#    counter file per spawn would otherwise accumulate one per explore forever. The plan guard's
#    own counter has exactly that problem today.
find "$dir" -type f -name '*.json' -mtime +1 -delete 2>/dev/null

counter="$dir/$agent_id.json"
calls=0
if [ -f "$counter" ] && jq -e . "$counter" >/dev/null 2>&1; then
    calls="$(jq -r '.calls // 0' "$counter" 2>/dev/null)"
    case "$calls" in '' | *[!0-9]*) calls=0 ;; esac
fi

# 4. Over budget. Deny and say what to do instead. Denying without a next action turns a
#    circuit breaker into a dead end, and the caller gets nothing rather than partial findings.
if [ "$calls" -ge "$max_calls" ]; then
    reason="Call budget reached for this explore spawn: $calls of $max_calls tool calls.

Report the findings you already have. Cite each one as file_path:line_number, and under Notes
name the angle you did not finish and the query you would have run next, so the orchestrator can
brief that angle separately rather than guessing what is missing.

Returning partial findings with the gap named is the expected outcome here, not a failure. An
empty report is the failure."
    jq -cn --arg r "$reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $r
      }
    }'
    exit 0
fi

# 5. Under budget. Count and allow. A counter we cannot persist would restart the count from
#    zero on the next call and never reach the budget, so failing open here is the honest
#    direction: the run continues unbounded rather than being denied on a bookkeeping error.
calls=$((calls + 1))
tmp="$counter.tmp.$$"
if jq -cn --argjson c "$calls" '{calls: $c}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$counter" 2>/dev/null
else
    rm -f "$tmp" 2>/dev/null
fi
exit 0
