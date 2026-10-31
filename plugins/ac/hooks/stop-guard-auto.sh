#!/bin/sh
# Stop guard for /ac:auto runs. Sequencing only.
#
# Blocks a turn-ending attempt while an /ac:auto run this session owns has no verdict on disk yet,
# and tells the orchestrator what is owed. Once the verdict exists and the marker still does, it
# blocks one more time (phase `closing`, budget 1) for the close: the named outward actions, the
# marker's deletion and the report, which nothing else enforces.
# Every other condition fails OPEN (exit 0, no output): no marker, a marker owned by another
# session, a marker past its age bound, background work in flight that will wake the session, a
# missing run directory, a verdict already written, a latched or unwritable counter, and any
# parse uncertainty.
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
# reads six marker fields (slug, session_id, started_at, phase, source, source_ref) plus the
# existence of one file, and never opens the criteria file at all. Phase only scopes the block
# budget and the wording; source and source_ref only locate the run. Nothing below is allowed to
# grow into a satisfaction test.
#
# One owner per phase. An ac:auto marker is the away mode over whatever run is going, so it often
# coexists with another run marker this session owns, and two guards demanding different things at
# once leaves the model picking between them:
#   - source coordinate: while this session's active-coordinate.json exists, stop-guard-coordinate.sh
#     owns every stop (its phases, status lines and gate), and this guard exits 0. The coordinator's
#     .ac/coord/<source_ref>/verdict.md is the away run's verdict, and the 72 h coordinator age bound
#     applies. Once that marker is gone with no verdict, the run closed early and this guard owns the
#     stop, asking for the gate.
#   - any other source: stop-guard.sh owns the stop while a plan runs, and this guard's planning and
#     executing wording defers to it; from `gating` on, this guard owns it, and its predicate is
#     .ac/auto/<slug>/verdict.md.
#
# Why a hook and not a skill rule: after compaction Claude Code re-attaches the most recent
# invocation of each skill and keeps only the first 5,000 tokens of each, so the auto body's
# terminal-branch section is gone from context on exactly the long runs where a premature stop
# happens. The same docs name hooks as the deterministic layer when a skill stops influencing
# behavior: https://code.claude.com/docs/en/skills.md.
#
# The block budget defaults to 3 rather than the plan guard's 10 because the only work a block
# can buy here is one gate invocation. It is counted PER PHASE, not per run: this guard arms as
# soon as the marker exists, long before the gate is owed anything, so a whole-run pool of 3 would
# be spent on ordinary turn ends during planning and execution and latch before Phase 4 arrived,
# silencing the guard at exactly the moment it exists to speak. Per phase, the ceiling is 3 times
# the number of phases, which still terminates, and the gating handoff always starts full.
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
transcript_path="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

# 2a. The source run decides the run directory, the age bound and who owns the stop. An away run over a
#     coordinator run keeps no directory of its own: the coordinator's verdict is its verdict, and
#     while this session's coordinator marker lives, stop-guard-coordinate.sh owns every stop.
slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
[ -n "$slug" ] || exit 0
run_dir="$project_dir/.ac/auto/$slug"
max_age=86400
source_ref=""
source="$(jq -r '.source // empty' "$marker" 2>/dev/null)"
if [ "$source" = "coordinate" ]; then
    source_ref="$(jq -r '.source_ref // empty' "$marker" 2>/dev/null)"
    [ -n "$source_ref" ] || exit 0
    case "$source_ref" in *[!A-Za-z0-9._-]*) exit 0 ;; esac
    coord_marker="$project_dir/.ac/state/active-coordinate.json"
    if [ -f "$coord_marker" ] \
        && [ "$(jq -r '.session_id // empty' "$coord_marker" 2>/dev/null)" = "$hook_session" ]; then
        exit 0
    fi
    run_dir="$project_dir/.ac/coord/$source_ref"
    max_age=259200
fi
verdict_rel="${run_dir#"$project_dir"/}/verdict.md"
counter_rel="${run_dir#"$project_dir"/}/stop-guard-auto.json"

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
# A model-written local time with a trailing Z reads as up to 14h in the future (UTC+14 is the
# widest offset); accept that skew rather than going inert for the run.
{ [ "$age" -ge -50400 ] && [ "$age" -le "$max_age" ]; } || exit 0

# 3a. A question that timed out armed the latch (lib/question-wait.sh): the turn ends to wait for the
#     answer, which is correct, so allow. The latch is read, never consumed, because the other two
#     Stop guards see this same event.
qw_lib="$(dirname "$0")/lib/question-wait.sh"
if [ -f "$qw_lib" ]; then
    . "$qw_lib"
    qw_active "$hook_session" "$transcript_path" && exit 0
fi

# 3b. Work in flight that will wake the session (a background worker, a monitor, a finite shell):
#     ending the turn is how the run waits for it, so allow the stop without spending budget.
#     stop-guard.sh carries the measurement behind this; lib/wake-count.jq decides what counts.
wake_count="$(printf '%s' "$input" | jq -r --arg mode strict -f "$(dirname "$0")/lib/wake-count.jq" 2>/dev/null)" || exit 0
case "$wake_count" in '' | *[!0-9]*) exit 0 ;; esac
[ "$wake_count" -eq 0 ] || exit 0

# 4. A missing run directory is a malformed run: there is nowhere for a verdict to land and nowhere
#    to keep the counter, so we cannot judge.
[ -d "$run_dir" ] || exit 0

# The run's own phase, used below to scope the block budget. A marker written by an older
# version of the skill carries no `phase`, so default it rather than failing open: an absent
# field is not an uncertainty about whether the run is live, which is what the exits above test.
phase="$(jq -r '.phase // empty' "$marker" 2>/dev/null)"
[ -n "$phase" ] || phase="unknown"

# 5. The predicate. A verdict file means the gate has run and the run has an ending, whatever that
#    ending says: its contents are none of this hook's business. What is still owed then is Phase 4
#    (the named outward actions, the close, the report), and a marker still on disk keeps arming the
#    Bash and question guards, so the guard asks for it once, as its own `closing` phase with a
#    budget of 1, and then lets the turn end.
verdict="$run_dir/verdict.md"
if [ -f "$verdict" ]; then
    phase="closing"
    max_blocks=1
fi

# 6. Counter state, in a file so it survives compaction. It lives beside the run rather than in
#    .ac/state/ so a deleted run directory takes its budget with it. Keyed on the marker's
#    started_at so a new run always starts from zero. `spent` latches: once the budget is
#    exhausted this guard stops blocking the run entirely. Deleting the file instead would reset
#    the count and produce an unbounded block-budget-then-one-allow cycle for as long as the
#    marker lives, which is how a guard strands a user.
#    The budget is per PHASE, not per run, and that distinction is the whole reason this block
#    is worth reading. The guard arms as soon as the marker exists, which is long before the gate
#    is owed anything, so a whole-run pool of 3 gets spent on ordinary turn ends during planning
#    and execution and latches `spent` before Phase 4 ever arrives. That would silence the guard
#    at exactly the moment it exists to speak. Keying on phase gives each stage its own 3, with a
#    ceiling of 3 times the number of phases, so it still terminates and the gating handoff always
#    starts with a full budget. A phase change resets the count and clears a spent latch, because
#    the run demonstrably moved.
counter="$run_dir/stop-guard-auto.json"
blocks=0
if [ -f "$counter" ] && jq -e . "$counter" >/dev/null 2>&1; then
    prev_run="$(jq -r '.run // empty' "$counter" 2>/dev/null)"
    prev_phase="$(jq -r '.phase // empty' "$counter" 2>/dev/null)"
    if [ "$prev_run" = "$started_at" ] && [ "$prev_phase" = "$phase" ]; then
        [ "$(jq -r '.spent // false' "$counter" 2>/dev/null)" = "true" ] && exit 0
        blocks="$(jq -r '.blocks // 0' "$counter" 2>/dev/null)"
        case "$blocks" in '' | *[!0-9]*) blocks=0 ;; esac
    fi
fi

write_counter() {
    _tmp="$counter.tmp.$$"
    if jq -cn --arg run "$started_at" --arg ph "$phase" --argjson b "$1" --argjson s "$2" \
        '{run: $run, phase: $ph, blocks: $b, spent: $s}' > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$counter" 2>/dev/null && return 0
    fi
    rm -f "$_tmp" 2>/dev/null
    return 1
}

# 7. Budget spent. Latch and hand control back; the run is left without a verdict, which is a
#    worse outcome than a bad verdict but a better one than a session that cannot end.
if [ "$blocks" -ge "$max_blocks" ]; then
    write_counter "$blocks" true
    latch_note="ac auto stop-guard: block budget ($max_blocks) spent for $slug in phase $phase; allowing the turn to end."
    [ "$phase" = "closing" ] || latch_note="$latch_note No verdict was written to $verdict_rel."
    latch_note="$latch_note Re-invoke /ac:auto to resume: it reads this marker, sees this session owns it, and"
    latch_note="$latch_note picks the run up at its recorded phase. To close the run instead, delete the marker."
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
# What to do next depends on where the run is, and getting this wrong is not cosmetic. The plan
# Stop guard fires on the same event and, mid-run, its reason says to continue the wave loop.
# Both reasons reach the model together (measured). A fixed "hand off to the gate now" here would
# contradict it during planning and execution, and obeying this one would gate a half-finished
# run, whose verdict then releases this guard for good.
# The stage picks the wording. A coordinator source reaching here has lost its marker with no
# verdict: with frozen criteria the gate is owed, without them the coordinator aborted before its
# roadmap lock and the away run ends too. An execute source whose execute marker is gone has ended.
stage="$phase"
if [ "$phase" != "closing" ]; then
    if [ -n "$source_ref" ]; then
        stage="coordinate-aborted"
        [ -f "$run_dir/criteria.md" ] && stage="coordinate-closed"
    elif [ "$source" = "execute" ] && [ ! -e "$project_dir/.ac/state/active-execution.json" ]; then
        stage="source-ended"
    fi
fi
case "$stage" in
    closing)
        next_action="The verdict exists, so what is left is the close: run the named outward actions its status allows,
delete .ac/state/active-auto.json and the counter $counter_rel, and report (ac:auto Phase 4).
The marker still arms the away guards, so do not end the turn with it on disk."
        ;;
    coordinate-closed)
        next_action="The coordinator run this away run carries has closed without a verdict. Set the marker's phase
to gating, run the read-only gate against ${run_dir#"$project_dir"/}/criteria.md now and write its body
to $verdict_rel, then close the away run. A verdict reporting something unmet is a complete ending."
        ;;
    coordinate-aborted)
        next_action="The coordinator run this away run carries ended before its roadmap lock, so there are no frozen
criteria to gate against. Delete .ac/state/active-auto.json and report what happened and what is
recorded under ## Blocked in the decisions file."
        ;;
    source-ended)
        next_action="The execute run this away run carries has ended (its marker is gone). Set the marker's phase to
gating and hand off to the read-only gate now; it writes $verdict_rel."
        ;;
    planning | executing)
        next_action="The run is still working, so this is a note rather than an instruction: no verdict exists yet
and one will be owed at the end. Continue the run. If another guard blocked this same turn, follow
its reason; it knows what the current stage needs and this one does not. Once the source has
ended (its own marker gone, or the ad-hoc work finished), set the marker's phase to gating and run
the gate."
        ;;
    *)
        next_action="Hand off to the read-only gate now. It reviews the run and writes $verdict_rel.
A verdict reporting something unmet is a complete and correct ending: report it, do not go back
and try to make it pass. Running out of achievable work is a result for the gate to record, not
a reason to invent more work."
        ;;
esac

if [ "$stage" = "closing" ]; then
    state_line="State from disk: the marker .ac/state/active-auto.json and $verdict_rel both exist, so the
run is judged but not closed. This guard asks once; the next stop is allowed."
else
    state_line="State from disk: the marker .ac/state/active-auto.json exists and $verdict_rel does not.
That is the entire test this guard runs. It does not read what the run was asked to achieve and
it does not measure how much of it you managed, so nothing you do to the work itself will clear
it. The one action that clears it is the gate writing the verdict."
fi

reason="An /ac:auto away run for '$slug' is not finished, so this turn must not end.

$state_line

$next_action

No background worker of this session is running, so do not wait with a sleep, until or polling
loop in the foreground; while one runs, ending the turn is the right way to wait and this guard allows it (a wait you start yourself counts only under \`timeout N\`, N up to 3600 seconds, alone or after \`cd dir &&\`, \`NAME=value &&\` or \`export NAME=value &&\` segments with no substitution in them, with redirects allowed and no \`;\`, \`|\` or background \`&\`).

Context pressure is not a stopping condition. Auto-compaction summarizes older turns and the run
continues; do not announce a context or token-budget concern in place of finishing, and do not
hand the remainder back as a next step for a new session.

If the user asked you to stop, pause, or take back control, that is a legitimate halt and outranks this
guard: delete .ac/state/active-auto.json and stop. Do not argue with the user or keep working
through their request to stop."

jq -cn \
    --arg r "$reason" \
    --arg m "ac auto stop-guard: blocked stop $blocks/$max_blocks | $slug phase $phase" \
    '{decision: "block", reason: $r, systemMessage: $m}'
exit 0
