#!/bin/sh
# Stop guard for /ac:auto runs. Sequencing only.
#
# Blocks a turn-ending attempt only while an /ac:auto run this session owns has no verdict on
# disk yet, and tells the orchestrator that invoking the gate is the one action still owed.
# Every other condition fails OPEN (exit 0, no output): no marker, a marker owned by another
# session, a marker past its age bound, a missing run directory, a verdict already written, a
# latched or unwritable counter, and any parse uncertainty.
#
# Why a second Stop hook rather than a branch inside stop-guard.sh: the two predicates are
# disjoint and answer different questions. stop-guard.sh asks "is the plan finished", read from
# the plan's step checkboxes. This one asks "has the gate written a verdict". Both hooks fire on
# every Stop event, a block from either beats an allow from the other, and when both block the
# model receives both reasons. Keeping them separate costs nothing and keeps each predicate
# small enough to reason about; folding this one in would couple a verdict question to a
# checkbox question that can be true or false independently.
#
# Why the predicate is sequencing and never satisfaction: reading the run's criteria file and
# blocking while some criterion is unmet has no terminus. It would force the model to invent
# work at exactly the point where the real work has run out, which is the failure this design
# exists to avoid. An unmet criterion is a verdict outcome, not a reason to block: a verdict
# reporting a criterion unmet is a complete and legitimate ending for the run. So this hook
# reads exactly three marker fields (slug, session_id, started_at) plus the existence of one
# file, and never opens the criteria file at all. Nothing below is allowed to grow into a
# satisfaction test.
#
# Why a hook and not a skill rule: after compaction Claude Code re-attaches the most recent
# invocation of each skill and keeps only the first 5,000 tokens of each, so the auto body's
# terminal-branch section is gone from context on exactly the long runs where a premature stop
# happens. The same docs name hooks as the deterministic layer when a skill stops influencing
# behavior: https://code.claude.com/docs/en/skills.md.
#
# The block budget defaults to 3 rather than the plan guard's 10 because the only work a block
# can buy here is one gate invocation. Past a few attempts, blocking again only repeats the
# exchange while the user waits.
#
# Known limits, inherited from stop-guard.sh and deliberate:
#   - `--resume --fork-session` keeps the fresh startup session id rather than the resumed one
#     (utils/sessionRestore.ts:452-453), so the ownership check below fails and the guard goes
#     inert for that run. Failing open is the correct direction.
#   - The marker is a single global slot per repository. Two concurrent /ac:auto runs leave the
#     second owning the marker and the first unguarded.
#   - A bare `Stop` registration never fires for subagents; utils/hooks.ts:3654 routes those to
#     SubagentStop. Blast radius is the main thread only.

set -u

# Block budget. A block hands the model one more turn, and one turn is all a gate run needs.
max_blocks="${AC_AUTO_MAX_BLOCKS:-3}"
case "$max_blocks" in
    '' | *[!0-9]*) max_blocks=3 ;;
esac

# 0. Read the payload. jq is the only parser; without either we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# Resolve the tree that holds the .ac/ state. The payload cwd follows a worktree; the stable
# root deliberately does not (utils/hooks.ts:813-816: "getProjectRoot() is never updated when
# entering a worktree"), and every .ac/ path the auto skill writes is cwd-relative. So probe the
# payload cwd first, fall back to the stable root, and only then to PWD.
payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
project_dir=""
for _cand in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$_cand" ] || continue
    if [ -e "$_cand/.ac/state/active-auto.json" ]; then
        project_dir="$_cand"
        break
    fi
done
[ -n "$project_dir" ] || project_dir="${payload_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"

marker="$project_dir/.ac/state/active-auto.json"

# 1. No marker means no active auto run. The guard is dormant outside runs, so allow.
[ -f "$marker" ] || exit 0
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 2. Ownership. Only the session that wrote the marker may be blocked by it, so a marker left
#    behind by another session cannot trap an unrelated session in the same repository.
#    session_id is the signal, not pid: the orchestrator cannot learn its own process id (a `$$`
#    from Bash yields a short-lived subshell), and real markers carry `"pid": 0`, which passes
#    `kill -0` only because pid 0 addresses the process group.
#    Both auto-compaction and --resume preserve the session id, so a run that survives either
#    still matches (services/compact/compact.ts:591-592 only fires the SessionStart hooks;
#    utils/sessionRestore.ts:436-446 reuses the resumed id).
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

# 3. Age bound as a second floor: a run this session started but abandoned long ago should not
#    keep blocking. A parse failure means we cannot confirm freshness, so allow.
now_epoch="$(date -u +%s 2>/dev/null)" || exit 0

started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
[ -n "$started_at" ] || exit 0

started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
    || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
    || started_epoch=""
[ -n "$started_epoch" ] || exit 0

age=$((now_epoch - started_epoch))
{ [ "$age" -ge 0 ] && [ "$age" -le 86400 ]; } || exit 0

# 4. Resolve the run directory the marker names. A missing directory is a malformed run: there
#    is nowhere for a verdict to land and nowhere to keep the counter, so we cannot judge.
slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
[ -n "$slug" ] || exit 0

run_dir="$project_dir/.ac/auto/$slug"
[ -d "$run_dir" ] || exit 0

# 5. The whole predicate. A verdict file exists, so the gate has run and the run has an ending,
#    whatever that ending says. Its contents are none of this hook's business: a verdict that
#    reports something unmet ends the run exactly as a clean one does.
verdict="$run_dir/verdict.md"
[ -f "$verdict" ] && exit 0

# 6. Counter state, in a file so it survives compaction. It lives beside the run rather than in
#    .ac/state/ so a deleted run directory takes its budget with it. Keyed on the marker's
#    started_at so a new run always starts from zero. `spent` latches: once the budget is
#    exhausted this guard stops blocking the run entirely. Deleting the file instead would reset
#    the count and produce an unbounded block-budget-then-one-allow cycle for as long as the
#    marker lives, which is how a guard strands a user.
counter="$run_dir/stop-guard-auto.json"
blocks=0
if [ -f "$counter" ] && jq -e . "$counter" >/dev/null 2>&1; then
    prev_run="$(jq -r '.run // empty' "$counter" 2>/dev/null)"
    if [ "$prev_run" = "$started_at" ]; then
        [ "$(jq -r '.spent // false' "$counter" 2>/dev/null)" = "true" ] && exit 0
        blocks="$(jq -r '.blocks // 0' "$counter" 2>/dev/null)"
        case "$blocks" in '' | *[!0-9]*) blocks=0 ;; esac
    fi
fi

write_counter() {
    _tmp="$counter.tmp.$$"
    if jq -cn --arg run "$started_at" --argjson b "$1" --argjson s "$2" \
        '{run: $run, blocks: $b, spent: $s}' > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$counter" 2>/dev/null && return 0
    fi
    rm -f "$_tmp" 2>/dev/null
    return 1
}

# 7. Budget spent. Latch and hand control back; the run is left without a verdict, which is a
#    worse outcome than a bad verdict but a better one than a session that cannot end.
if [ "$blocks" -ge "$max_blocks" ]; then
    write_counter "$blocks" true
    latch_note="ac auto stop-guard: block budget ($max_blocks) spent for $slug; allowing the turn to end."
    latch_note="$latch_note No verdict was written to .ac/auto/$slug/verdict.md."
    latch_note="$latch_note Resume with /ac:auto, or delete .ac/state/active-auto.json to close the run."
    printf '%s\n' "$latch_note" >&2
    exit 0
fi

# A counter we cannot persist means the next Stop would restart the count from zero and block
# forever. Fail open, matching this file's stated policy.
blocks=$((blocks + 1))
write_counter "$blocks" false || exit 0

# 8. Confirmed: a live /ac:auto run owned by this session tried to end the turn before the gate
#    wrote anything. `reason` is the documented channel for telling Claude why it should
#    continue (https://code.claude.com/docs/en/hooks.md), so it carries the directive; the
#    factual-phrasing rule from the same page applies to additionalContext, not here.
reason="An /ac:auto run for '$slug' has not been judged yet, so this turn must not end.

State from disk: the marker .ac/state/active-auto.json exists and .ac/auto/$slug/verdict.md does not.
That is the entire test this guard runs. It does not read what the run was asked to achieve and
it does not measure how much of it you managed, so nothing you do to the work itself will clear
it. The one action that clears it is the gate writing the verdict.

Hand off to the read-only gate now. It reviews the run and writes .ac/auto/$slug/verdict.md.
A verdict reporting something unmet is a complete and correct ending: report it, do not go back
and try to make it pass. Running out of achievable work is a result for the gate to record, not
a reason to invent more work.

Context pressure is not a stopping condition. Auto-compaction summarizes older turns and the run
continues; do not announce a context or token-budget concern in place of finishing, and do not
hand the remainder back as a next step for a new session.

If the user asked you to stop, pause, or hand off, that is a legitimate halt and outranks this
guard: delete .ac/state/active-auto.json and stop. Do not argue with the user or keep working
through their request to stop."

jq -cn \
    --arg r "$reason" \
    --arg m "ac auto stop-guard: blocked stop $blocks/$max_blocks | $slug has no verdict yet" \
    '{decision: "block", reason: $r, systemMessage: $m}'
exit 0
