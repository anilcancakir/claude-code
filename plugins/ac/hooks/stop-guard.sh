#!/bin/sh
# Stop guard for ac plan execution.
#
# Blocks a turn-ending attempt only while an /ac:execute run this session owns is
# demonstrably still in flight, and tells the orchestrator what remains. Every other
# condition fails OPEN (exit 0, no output): no marker, a marker owned by another session,
# a marker past its age bound, an unreadable plan, a latched or unwritable counter, and any
# parse uncertainty.
#
# Why a hook and not a skill rule: docs/skills.md:298-300 keeps only the first 5,000 tokens
# of a re-attached skill after compaction, so the execute body's terminal-branch and
# error-handling sections are gone from context on exactly the long runs where a premature
# stop happens. docs/skills.md:301 names hooks as the deterministic layer. The shape follows
# anthropics/claude-code plugins/ralph-wiggum/hooks/stop-hook.sh: the loop counter lives in
# a file the hook increments, never in the model's working memory.
#
# The marker's existence IS the predicate. The execute skill deletes it at Phase 4a and on
# every branch that terminates the run (see plugins/ac/skills/execute/SKILL.md marker
# lifecycle), so a legitimate halt has already removed it before the turn ends.
#
# Known limits, deliberate:
#   - `--resume --fork-session` keeps the fresh startup session id rather than the resumed
#     one (utils/sessionRestore.ts:452-453), so the ownership check below fails and the guard
#     goes inert for that run. Failing open is the correct direction; a forked session is a
#     new run and should write its own marker.
#   - The marker is a single global slot per repository. Two concurrent /ac:execute runs in
#     one repository leave the second owning the marker and the first unguarded.
#   - A bare `Stop` registration never fires for subagents; utils/hooks.ts:3654 routes those
#     to SubagentStop. Blast radius is the main thread only.

set -u

# Block budget. A block hands the model one more turn; a healthy auto run needs very few.
max_blocks="${AC_STOP_GUARD_MAX_BLOCKS:-10}"
case "$max_blocks" in
    '' | *[!0-9]*) max_blocks=10 ;;
esac

# 0. Read the payload. jq is the only parser; without either we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# $CLAUDE_PROJECT_DIR is the documented project-root anchor (docs/hooks.md:406). The payload
# cwd is getCwd(), which can drift from the root, so it is only the fallback.
project_dir="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$project_dir" ]; then
    project_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
fi
[ -n "$project_dir" ] || project_dir="$PWD"

marker="$project_dir/.ac/state/active-execution.json"

# 1. No marker means no active run. The guard is dormant outside runs, so allow.
[ -f "$marker" ] || exit 0
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 2. Ownership. Only the session that wrote the marker may be blocked by it, so a marker
#    left behind by another session cannot trap an unrelated session in the same repository.
#    session_id is the signal, not pid: the orchestrator cannot learn its own process id (a
#    `$$` from Bash yields a short-lived subshell), and real markers carry `"pid": 0`, which
#    passes `kill -0` only because pid 0 addresses the process group.
#    Both auto-compaction and --resume preserve the session id, so a run that survives
#    either still matches (services/compact/compact.ts:591-592 only fires the SessionStart
#    hooks; utils/sessionRestore.ts:436-446 reuses the resumed id).
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

# 3. Age bound as a second floor: a run this session started but abandoned long ago should
#    not keep blocking. A parse failure means we cannot confirm freshness, so allow.
now_epoch="$(date -u +%s 2>/dev/null)" || exit 0

started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
[ -n "$started_at" ] || exit 0

started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
    || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
    || started_epoch=""
[ -n "$started_epoch" ] || exit 0

age=$((now_epoch - started_epoch))
{ [ "$age" -ge 0 ] && [ "$age" -le 86400 ]; } || exit 0

# 4. Resolve the plan the marker names. Without a readable plan we cannot say what remains,
#    and a block with no concrete next action is worse than no block, so allow.
slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
[ -n "$slug" ] || exit 0

plan_file="$project_dir/.ac/plans/$slug/plan.md"
[ -f "$plan_file" ] || exit 0

unchecked="$( { grep -c '^- \[ \] ' "$plan_file" 2>/dev/null || echo 0; } | tail -1 )"
checked="$( { grep -c '^- \[x\] ' "$plan_file" 2>/dev/null || echo 0; } | tail -1 )"
case "$unchecked" in '' | *[!0-9]*) unchecked=0 ;; esac
case "$checked" in '' | *[!0-9]*) checked=0 ;; esac
total=$((unchecked + checked))

# A plan with no step checkboxes at all is an unrecognized shape, so allow.
[ "$total" -gt 0 ] || exit 0

next_step="$(grep -m1 '^- \[ \] ' "$plan_file" 2>/dev/null | sed -E 's/^- \[ \] \*\*[^*]*\*\*: *//')"
[ -n "$next_step" ] || next_step="(all steps checked; Phase 3 review and Phase 4 deliver remain)"

wave="$(jq -r '.current_wave // empty' "$marker" 2>/dev/null)"
[ -n "$wave" ] || wave="unknown"

# 5. Counter state, in a file so it survives compaction. Keyed on the marker's started_at so
#    a new run always starts from zero. `spent` latches: once the budget is exhausted the
#    guard stops blocking this run entirely. Deleting the file instead would reset the count
#    and produce an unbounded block-budget-then-one-allow cycle for as long as the marker
#    lives, which is how a guard strands a user.
counter="$project_dir/.ac/state/stop-guard.json"
blocks=0
prev_unchecked=""
if [ -f "$counter" ] && jq -e . "$counter" >/dev/null 2>&1; then
    prev_run="$(jq -r '.run // empty' "$counter" 2>/dev/null)"
    if [ "$prev_run" = "$started_at" ]; then
        [ "$(jq -r '.spent // false' "$counter" 2>/dev/null)" = "true" ] && exit 0
        blocks="$(jq -r '.blocks // 0' "$counter" 2>/dev/null)"
        prev_unchecked="$(jq -r '.unchecked // empty' "$counter" 2>/dev/null)"
        case "$blocks" in '' | *[!0-9]*) blocks=0 ;; esac
        case "$prev_unchecked" in *[!0-9]*) prev_unchecked="" ;; esac
    fi
fi

# 6. Progress test. A guard that only counts blocks can be satisfied by one token of work
#    and a second stop. Compare the unchecked count against the previous block's: when it has
#    not moved, this block is the last one, and the reason says so.
stop_hook_active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)"
no_progress="false"
if [ -n "$prev_unchecked" ] && [ "$unchecked" -ge "$prev_unchecked" ]; then
    no_progress="true"
fi

if [ "$blocks" -ge "$max_blocks" ]; then
    latch_reason="block budget ($max_blocks) spent"
elif [ "$no_progress" = "true" ] && [ "$stop_hook_active" = "true" ]; then
    # Already inside a forced continuation and the plan did not move. Blocking again would
    # only repeat the exchange, so hand control back now.
    latch_reason="no progress across a forced continuation"
else
    latch_reason=""
fi

write_counter() {
    _tmp="$counter.tmp.$$"
    if jq -cn --arg run "$started_at" --argjson b "$1" --argjson u "$unchecked" --argjson s "$2" \
        '{run: $run, blocks: $b, unchecked: $u, spent: $s}' > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$counter" 2>/dev/null && return 0
    fi
    rm -f "$_tmp" 2>/dev/null
    return 1
}

if [ -n "$latch_reason" ]; then
    write_counter "$blocks" true
    printf '%s\n' "ac stop-guard: $latch_reason for $slug; allowing the turn to end. $unchecked of $total steps remain unchecked. Resume with /ac:execute $slug." >&2
    exit 0
fi

# A counter we cannot persist means the next Stop would restart the count from zero and
# block forever. Fail open, matching this file's stated policy.
blocks=$((blocks + 1))
write_counter "$blocks" false || exit 0

# 7. Confirmed: a live /ac:execute run owned by this session, with work outstanding, tried to
#    end the turn. `reason` is the documented channel for telling Claude why it should
#    continue (docs/hooks.md:1791-1805), so it carries the directive; the factual-phrasing
#    rule at docs/hooks.md:692 applies to additionalContext, not here.
progress_note=""
if [ "$no_progress" = "true" ]; then
    progress_note="
This turn was handed back to you before and the unchecked count has not moved since. Blocking is not a substitute for progress: either complete the next step or take a terminal branch. This guard stops blocking once the budget is spent, and the run will simply be left unfinished."
fi

reason="An /ac:execute run for '$slug' is still in flight, so this turn must not end yet.

State from disk: wave $wave, $checked of $total steps checked, $unchecked unchecked.
Next unchecked step: $next_step
Authoritative step state: .ac/plans/$slug/plan.md (the task list is a mirror of it).
$progress_note
Context pressure is not a stopping condition. Auto-compaction summarizes older turns and the run continues; do not announce a context or token-budget concern in place of finishing, and do not hand the remainder back as a next step for a new session. If a compaction just happened, only the first 5,000 tokens of the ac:execute body survived it: re-invoke the ac:execute skill to restore the full body, then continue from the plan file.

If the user asked you to stop, pause, or hand off, that is a legitimate halt and outranks this guard: delete .ac/state/active-execution.json and stop. Do not argue with the user or keep working through their request to stop.

The internal halts each have a branch in the execute skill: Phase 2i wave dependency failed, Phase 2j 3-strike, Phase 3d plan-spec issue, a wave checkpoint commit failure. Every one of them surfaces an AskUserQuestion and deletes the marker before the run stops. Take that branch if one genuinely applies; the marker's absence is what lets this turn end.

Otherwise: continue the wave loop from the next unchecked step."

jq -cn \
    --arg r "$reason" \
    --arg m "ac stop-guard: blocked stop $blocks/$max_blocks | $slug wave $wave, $unchecked/$total steps unchecked" \
    '{decision: "block", reason: $r, systemMessage: $m}'
exit 0
