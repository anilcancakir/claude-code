#!/bin/sh
# Stop guard for ac plan execution.
#
# Blocks a turn-ending attempt only while an /ac:execute run is demonstrably still in
# flight, and tells the orchestrator what remains. Every other condition fails OPEN
# (exit 0, no output): no marker, a stale marker from a crashed run, an unreadable plan
# file, a spent block budget, and any parse or resolution uncertainty.
#
# Why a hook and not a skill rule: `docs/skills.md:298-300` keeps only the first 5,000
# tokens of a re-attached skill after compaction, so the execute body's terminal-branch
# and error-handling sections are gone from context on exactly the long runs where a
# premature stop happens. `docs/skills.md:301` names hooks as the deterministic layer.
# The shape follows anthropics/claude-code plugins/ralph-wiggum/hooks/stop-hook.sh: the
# loop counter lives in a file and the hook increments it, never the model.
#
# The marker's existence IS the predicate. The execute skill deletes it at Phase 4a and on
# every branch that terminates the run (see plugins/ac/skills/execute/SKILL.md marker
# lifecycle), so a legitimate halt has already removed it before the turn ends.

set -u

# Block budget. A block hands the model one more turn; a healthy auto run needs very few.
# Past the budget the user gets control back rather than being stuck in a block loop.
max_blocks="${AC_STOP_GUARD_MAX_BLOCKS:-10}"
case "$max_blocks" in
    '' | *[!0-9]*) max_blocks=10 ;;
esac

# 0. Read the payload. jq is the only parser; without either we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

project_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$project_dir" ] || project_dir="$PWD"

marker="$project_dir/.ac/state/active-execution.json"

# 1. No marker means no active run. The guard is dormant outside runs, so allow.
[ -f "$marker" ] || exit 0
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 2. Ownership. To reach a block we must POSITIVELY confirm this session owns the run.
#    The marker's session_id is the only trustworthy signal here. The pid field is NOT
#    usable: the orchestrator cannot learn its own process id (a `$$` from Bash yields a
#    short-lived subshell), and real markers in the field carry `"pid": 0`, which passes
#    `kill -0` only because pid 0 addresses the process group. Gating on it would either
#    pass by accident or fail wrongly depending on what the model guessed.
#
#    Matching on session_id also scopes the guard correctly: a marker left behind by
#    another session must never block turn ends in an unrelated session working in the
#    same repository. Compaction and `--resume` both preserve the session id, so a run
#    that survives either still matches.
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

# Age bound as a second floor: a run this session started but abandoned long ago should
# not keep blocking. A parse failure means we cannot confirm freshness, so allow.
now_epoch="$(date -u +%s 2>/dev/null)" || exit 0

started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
[ -n "$started_at" ] || exit 0

started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
    || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
    || started_epoch=""
[ -n "$started_epoch" ] || exit 0

age=$((now_epoch - started_epoch))
{ [ "$age" -ge 0 ] && [ "$age" -le 86400 ]; } || exit 0

# 3. Resolve the plan the marker names. Without a readable plan we cannot say what remains,
#    and a block with no concrete next action is worse than no block, so allow.
slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
[ -n "$slug" ] || exit 0

plan_file="$project_dir/.ac/plans/$slug/plan.md"
[ -f "$plan_file" ] || exit 0

unchecked="$(grep -c '^- \[ \] ' "$plan_file" 2>/dev/null || true)"
checked="$(grep -c '^- \[x\] ' "$plan_file" 2>/dev/null || true)"
case "$unchecked" in '' | *[!0-9]*) unchecked=0 ;; esac
case "$checked" in '' | *[!0-9]*) checked=0 ;; esac
total=$((unchecked + checked))

# A plan with no step checkboxes at all is an unrecognized shape, so allow.
[ "$total" -gt 0 ] || exit 0

next_step="$(grep -m1 '^- \[ \] ' "$plan_file" 2>/dev/null | sed -E 's/^- \[ \] \*\*[^*]*\*\*: *//')"
[ -n "$next_step" ] || next_step="(all steps checked; Phase 3 review and Phase 4 deliver remain)"

wave="$(jq -r '.current_wave // empty' "$marker" 2>/dev/null)"
[ -n "$wave" ] || wave="unknown"

# 4. Block budget, counted in a file so the count survives compaction. The counter is keyed
#    on the marker's started_at, so a new run always starts from zero.
counter="$project_dir/.ac/state/stop-guard.json"
blocks=0
if [ -f "$counter" ] && jq -e . "$counter" >/dev/null 2>&1; then
    prev_run="$(jq -r '.run // empty' "$counter" 2>/dev/null)"
    if [ "$prev_run" = "$started_at" ]; then
        blocks="$(jq -r '.blocks // 0' "$counter" 2>/dev/null)"
        case "$blocks" in '' | *[!0-9]*) blocks=0 ;; esac
    fi
fi

if [ "$blocks" -ge "$max_blocks" ]; then
    # Budget spent. Hand control back and clear the counter so a later run is not penalized.
    rm -f "$counter" 2>/dev/null
    printf '%s\n' "ac stop-guard: block budget ($max_blocks) spent for $slug; allowing the turn to end. $unchecked of $total steps remain unchecked. Resume with /ac:execute $slug." >&2
    exit 0
fi

blocks=$((blocks + 1))
tmp="$counter.tmp.$$"
if jq -cn --arg run "$started_at" --argjson b "$blocks" '{run: $run, blocks: $b}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$counter" 2>/dev/null || rm -f "$tmp" 2>/dev/null
else
    rm -f "$tmp" 2>/dev/null
fi

# 5. Confirmed: a live /ac:execute run with work outstanding tried to end the turn.
#    `reason` is the documented channel for telling Claude why it should continue
#    (docs/hooks.md:1791-1805), so it carries the directive; the factual-phrasing rule at
#    docs/hooks.md:692 applies to additionalContext, not here.
reason="An /ac:execute run for '$slug' is still in flight, so this turn must not end yet.

State from disk: wave $wave, $checked of $total steps checked, $unchecked unchecked.
Next unchecked step: $next_step
Authoritative step state: .ac/plans/$slug/plan.md (the task list is a mirror of it).

Context pressure is not a stopping condition. Auto-compaction summarizes older turns and the run continues; do not announce a context or token-budget concern in place of finishing, and do not hand the remainder back as a next step for a new session. If a compaction just happened, only the first 5,000 tokens of the ac:execute body survived it: re-invoke the ac:execute skill to restore the full body, then continue from the plan file.

Legitimate halts still exist, and each one has a branch in the execute skill: Phase 2i wave dependency failed, Phase 2j 3-strike, Phase 3d plan-spec issue, a wave checkpoint commit failure. Every one of them surfaces an AskUserQuestion and deletes .ac/state/active-execution.json before the run stops. Take that branch if one genuinely applies; the marker's absence is what lets this turn end.

Otherwise: continue the wave loop from the next unchecked step."

jq -cn \
    --arg r "$reason" \
    --arg m "ac stop-guard: blocked stop $blocks/$max_blocks | $slug wave $wave, $unchecked/$total steps unchecked" \
    '{decision: "block", reason: $r, systemMessage: $m}'
exit 0
