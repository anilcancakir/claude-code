#!/bin/sh
# Stop guard for /ac:coordinate runs: sequencing, plus one status-line check per prompt (5b).
#
# Blocks a turn-ending attempt only while a coordinator run this session owns has no verdict on
# disk yet, with nothing running that will wake the session. That is the stall this exists for: a
# coordinator that ends its turn with bundles open and no lane working, and so never resumes.
# Every other condition fails OPEN (exit 0, no output): no marker, a marker owned by another
# session, a marker past its age bound, a slug that is not a plain name, a missing run directory,
# a verdict already written, background work in flight that will wake the session, an armed
# question-wait latch, a latched or unwritable counter, and any parse uncertainty.
#
# Modelled on stop-guard-auto.sh and registered beside it rather than folded into it: the marker,
# the run root (.ac/coord/<slug>/) and the closing artifact differ, and a block from either hook
# beats an allow from the other. The predicate stays sequencing and never satisfaction: it reads
# the marker's slug, session_id, started_at and phase plus the existence of verdict.md, and reads
# state.json only to NAME the open bundles in the reason, never to decide.
#
# A lane parked on its own workers stays a running `subagent` task in the Stop payload, so
# lib/wake-count.jq in strict mode counts it and the coordinator may end its turn to wait. The age
# bound is 72 hours rather than the auto guard's 24 because a coordinator run spans several
# bundle waves and the question-timeout hook already treats the marker as live for that long
# (posttooluse-question-timeout.sh, max_age=259200).
#
# The block budget is 3 per phase, counted in the run directory and keyed on the marker's
# started_at plus phase, for the same reason as stop-guard-auto.sh: a whole-run pool would be
# spent on ordinary turn ends in an early phase and latch before the gating handoff, and a phase
# change proves the run moved. `spent` latches; deleting the counter would restart the count and
# strand the session in a block-three-then-allow cycle.
#
# Known limits, inherited from stop-guard.sh and deliberate: a forked resume keeps a fresh session
# id so ownership fails and the guard goes inert; the marker is one global slot per repository;
# a bare `Stop` registration never fires for subagents (utils/hooks.ts:3654).

set -u

max_blocks="${AC_COORDINATE_MAX_BLOCKS:-3}"
case "$max_blocks" in
    '' | *[!0-9]*) max_blocks=3 ;;
esac

# 0. Read the payload. jq is the only parser; without either we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# Resolve the tree that holds the .ac/ state: payload cwd first (it follows a worktree), then the
# stable root (utils/hooks.ts:813-816), then PWD.
payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
project_dir=""
for _cand in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$_cand" ] || continue
    if [ -e "$_cand/.ac/state/active-coordinate.json" ]; then
        project_dir="$_cand"
        break
    fi
done
[ -n "$project_dir" ] || project_dir="${payload_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"

marker="$project_dir/.ac/state/active-coordinate.json"

# 1. No marker means no active coordinator run.
[ -f "$marker" ] || exit 0
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 2. Ownership by session_id, as in stop-guard-auto.sh: a marker left by another session cannot
#    trap an unrelated one in the same repository.
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
transcript_path="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

# 3. Age bound: 72 hours, with the same 14 hour future skew as the auto guard for a model-written
#    local time carrying a trailing Z. A parse failure means freshness is unconfirmed, so allow.
now_epoch="$(date -u +%s 2>/dev/null)" || exit 0

started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
[ -n "$started_at" ] || exit 0

started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
    || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
    || started_epoch=""
[ -n "$started_epoch" ] || exit 0

age=$((now_epoch - started_epoch))
{ [ "$age" -ge -50400 ] && [ "$age" -le 259200 ]; } || exit 0

# 4. The slug names a directory, so it is checked before any path is built from it
#    (posttooluse-question-timeout.sh:169). A missing run directory is a malformed run.
slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
[ -n "$slug" ] || exit 0
case "$slug" in *[!A-Za-z0-9._-]*) exit 0 ;; esac

run_dir="$project_dir/.ac/coord/$slug"
[ -d "$run_dir" ] || exit 0

phase="$(jq -r '.phase // empty' "$marker" 2>/dev/null)"
[ -n "$phase" ] || phase="unknown"

# 5. The whole predicate: a verdict exists, so the run has its ending, whatever it says.
[ -f "$run_dir/verdict.md" ] && exit 0

# 5a. A timed-out question armed the latch (lib/question-wait.sh): the turn ends to wait for the
#     answer, which is correct, and its one-line wait carries no status lines. Read, never consumed: the other Stop guards see this same event.
qw_lib="$(dirname "$0")/lib/question-wait.sh"
if [ -f "$qw_lib" ]; then
    . "$qw_lib"
    qw_active "$hook_session" "$transcript_path" && exit 0
fi

# 5b. Status lines. The skill asks every turn end for three lines read off state.json and the marker; a Sonnet
#     coordinator measured on 2026-10-27 dropped the phase from every one, so the owner could not tell an
#     integration from a dispatch. Checked once per prompt (`stop_hook_active` false), whatever is running, and
#     only when the payload carries the reply; it never touches the sequencing budget below.
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" != "true" ]; then
    reply="$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)"
    if [ -n "$reply" ] && ! printf '%s\n' "$reply" | grep -Eq "^[-*> ]*[*]*progress:[*]*[[:space:]]+[0-9]+/[0-9]+ bundles merged, phase $phase[*]*[[:space:]]*\$"; then
        status_reason="End every /ac:coordinate turn with the three status lines, read off state.json and the marker (phase $phase now), as the last thing before the turn ends or before an AskUserQuestion call:

progress: <merged>/<total> bundles merged, phase $phase
lanes: <id> <status> [<checked>/<total>], ... (or none)
owner: <ids in owner_queue> (or none)

Write them now and end the turn again; nothing else is needed."
        jq -cn --arg r "$status_reason" \
            --arg m "ac coordinate stop-guard: status lines missing for $slug" \
            '{decision: "block", reason: $r, systemMessage: $m}'
        exit 0
    fi
fi

# 5c. Work in flight that will wake the session: ending the turn is how the run waits for it.
wake_count="$(printf '%s' "$input" | jq -r --arg mode strict -f "$(dirname "$0")/lib/wake-count.jq" 2>/dev/null)" || exit 0
case "$wake_count" in '' | *[!0-9]*) exit 0 ;; esac
[ "$wake_count" -eq 0 ] || exit 0

# 6. Counter, per phase with a spent latch; see the header for why.
counter="$run_dir/stop-guard-coordinate.json"
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

# 7. Budget spent: latch and hand control back. A run without a verdict is worse than one with a
#    bad verdict, but better than a session that cannot end.
if [ "$blocks" -ge "$max_blocks" ]; then
    write_counter "$blocks" true
    latch_note="ac coordinate stop-guard: block budget ($max_blocks) spent for $slug in phase $phase; allowing the turn to end."
    latch_note="$latch_note No verdict was written to .ac/coord/$slug/verdict.md."
    latch_note="$latch_note Re-invoke /ac:coordinate to resume from state.json. To close the run instead, delete the marker."
    printf '%s\n' "$latch_note" >&2
    exit 0
fi

# A counter we cannot persist would restart at zero on the next Stop and block forever. Fail open.
blocks=$((blocks + 1))
write_counter "$blocks" false || exit 0

# 8. Confirmed: a live coordinator run this session owns tried to end its turn with no verdict and
#    nothing running. The open bundles come from state.json (status not merged or dropped), read
#    only to name them; an unreadable or absent file names none.
open_bundles="$(jq -r '
    [(.bundles // [])[] | select((.status // "") as $s | $s != "merged" and $s != "dropped")
        | "\(.id // "?") (\(.status // "?"))"]
    | join(", ")' "$run_dir/state.json" 2>/dev/null)" || open_bundles=""
[ -n "$open_bundles" ] || open_bundles="none recorded"

case "$phase" in
    roadmap)
        next_action="Finish the roadmap: get it oracle-reviewed, then ask the owner with the Roadmap? question. Dispatch starts only after that answer."
        ;;
    dispatch)
        next_action="Dispatch every bundle whose dependencies are merged, up to max_lanes, and act on lane messages: queue DECISIONS and BLOCKED for one batched owner round, send EXECUTE to PLANNED lanes, and archive DONE bundles."
        ;;
    integrate)
        next_action="Merge each done bundle into the integration branch, archive it, then remove its worktree. Rebase or ask with Conflict? on a merge conflict."
        ;;
    gating)
        next_action="Run the verifier against criteria.md and write its body to .ac/coord/$slug/verdict.md, then ask the owner with Push?."
        ;;
    *)
        next_action="Read .ac/coord/$slug/state.json and continue from the first bundle that is not merged or dropped."
        ;;
esac

reason="A /ac:coordinate run for '$slug' has no verdict yet and nothing of this session is running, so this turn must not end.

State from disk: marker .ac/state/active-coordinate.json (phase $phase), .ac/coord/$slug/verdict.md absent. Open bundles: $open_bundles. That is the entire test this guard runs; nothing you do to the work itself clears it. The one thing that clears it is the verdict.

Next action: $next_action

No lane or other background worker of this session is running, so do not wait with a sleep, until or polling loop in the foreground; while one runs, ending the turn is the right way to wait and this guard allows it (a wait you start yourself counts only under \`timeout N\`, N up to 3600 seconds, alone or after \`cd dir &&\`, \`NAME=value &&\` or \`export NAME=value &&\` segments with no substitution in them, with redirects allowed and no \`;\`, \`|\` or background \`&\`).

Context pressure is not a stopping condition. Auto-compaction summarizes older turns and the run continues from state.json; do not announce a context or token-budget concern in place of finishing.

If the user asked you to stop, pause, or take back control, that is a legitimate halt and outranks this guard: delete .ac/state/active-coordinate.json and stop. Do not argue with the user or keep working through their request to stop."

jq -cn \
    --arg r "$reason" \
    --arg m "ac coordinate stop-guard: blocked stop $blocks/$max_blocks | $slug has no verdict yet" \
    '{decision: "block", reason: $r, systemMessage: $m}'
exit 0
