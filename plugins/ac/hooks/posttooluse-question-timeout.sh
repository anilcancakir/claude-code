#!/bin/sh
# PostToolUse hook for AskUserQuestion, for a user who is away from the keyboard.
#
# The binary sets `afkTimeoutMs` in the tool response only on the idle-timeout path (outcome
# `afk_timeout`; payload shape verified 2026-10-17), and by then the model holds an empty answer
# set. Left alone it tends to proceed on its own judgment, which is right inside an /ac:auto run and
# wrong everywhere else. So this hook answers with one of two factual statements:
#   - wait:     the question is open; end the turn with one line naming it. This is the default, and
#               the only thing printed on any parse failure, a missing jq or any doubt.
#   - continue: only when this session owns a live /ac:auto run or a live /ac:coordinate run
#               (active-auto.json or active-coordinate.json, confirmed below), the question is not
#               an execute BLOCKER, and its header is not on the always-wait list (Topic?,
#               Agent fail?, Write fail?, Dep failed?, Halted?, Budget?, plus the coordinator's
#               Push?, Lane block? and Conflict?, so the final push and a lane BLOCKER relay never
#               auto-continue). Oracle CRIT? and Premise failed? continue once per run each, then
#               wait. A coordinator marker lives 72 h instead of 24 h because a roadmap run spans
#               days, and its continue text points at .ac/coord/<slug>/ since there is no plan.
# The wait branch arms the question-wait latch (lib/question-wait.sh) so the four Stop guards let
# the turn end; an answered question retires an old latch.
#
# Environment:
#   AC_QUESTION_TIMEOUT        0 turns the hook off
#   AC_QUESTION_TIMEOUT_SHAPE  context (default): hookSpecificOutput.additionalContext
#                              block: decision "block" with the text as the reason
#                              The experiment of 2026-10-17 (Claude Code 2.1.302, Opus 5.5) ended the turn
#                              on the wait text 3/3 in both shapes, so context stays the default.
#
# Both texts are fixed ASCII with no quote or backslash, so printf can build valid JSON without jq.
# updatedToolOutput is deliberately not used: the AskUserQuestion output shape is undocumented and a
# mismatch is silently ignored. active-execution.json is wait evidence only, never auto evidence.

set -u

wait_text="AskUserQuestion timed out with the user away, so it carries no answer."
wait_text="$wait_text Either this session is not in an ac:auto run or the question is a blocker, so proceeding"
wait_text="$wait_text on your own judgment is not authorised. End the turn with one line naming the open question"
wait_text="$wait_text and any selection already made. The user's reply will arrive as the next message."
continue_text_auto="AskUserQuestion timed out with the user away. This session owns the active ac:auto run and the"
continue_text_auto="$continue_text_auto question is not a blocker, so the run continues: take the selection already made, or"
continue_text_auto="$continue_text_auto otherwise the option marked Recommended, and record the choice as"
continue_text_auto="$continue_text_auto 'timed out, not user-approved' in the plan's Risks Accepted section and in the run report."
continue_text_coord="AskUserQuestion timed out with the user away. This session owns the active ac:coordinate run and the"
continue_text_coord="$continue_text_coord question is not a push, lane block or conflict relay, so the run continues: take the"
continue_text_coord="$continue_text_coord selection already made, or otherwise the option marked Recommended, and record the choice as"
continue_text_coord="$continue_text_coord 'timed out, not user-approved' in .ac/coord/<slug>/events.jsonl and state.json."

# 0. Off switch, then the payload. An empty read has no afkTimeoutMs either, so it ends silently.
[ "${AC_QUESTION_TIMEOUT:-}" = "0" ] && exit 0
input="$(cat 2>/dev/null)" || exit 0

# A missing lib only skips the latch; it never changes the wait or continue decision. Sourcing a
# missing file would exit a POSIX sh, hence the guard.
have_qw=""
qw_lib="$(dirname "$0")/lib/question-wait.sh"
if [ -f "$qw_lib" ]; then
    . "$qw_lib"
    have_qw=1
fi

# 1. Session id: jq when it parses the payload, a plain match otherwise (the pattern of
#    session-start-working-rules.sh:85-93). An unreadable id only skips the latch and the auto marker.
sid=""
if command -v jq >/dev/null 2>&1; then
    sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
fi
if [ -z "$sid" ]; then
    sid="$(printf '%s' "$input" | awk '
        match($0, "\"session_id\" *: *\"[^\"]*\"") {
            s = substr($0, RSTART, RLENGTH)
            sub("^\"session_id\" *: *\"", "", s)
            sub("\"$", "", s)
            print s
            exit
        }')"
fi

# 2. No afkTimeoutMs: the question was answered, not timed out. Stay silent and retire any latch an
#    earlier timeout armed, so the Stop guards go back to guarding.
case "$input" in
    *'"afkTimeoutMs"'*) ;;
    *)
        [ -n "$have_qw" ] && [ -n "$sid" ] && qw_clear "$sid"
        exit 0
        ;;
esac

emit() {
    shape="${AC_QUESTION_TIMEOUT_SHAPE:-context}"
    if [ "$shape" = "block" ]; then
        printf '{"decision":"block","reason":"%s"}\n' "$1"
    else
        printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$1"
    fi
    exit 0
}

wait_for_user() {
    [ -n "$have_qw" ] && [ -n "$sid" ] && qw_arm "$sid"
    emit "$wait_text"
}

# 3. The only route to the continue text. Every `return 1` is a failed confirmation and lands on the
#    wait text. Marker checks follow stop-guard-auto.sh:64-114 (project dir, ownership, age bound),
#    with the age bound at 24 h for an auto run and 72 h for a coordinator run, which spans days.
#    The two markers are tried in turn and the first one this session owns decides the run kind, so
#    another session's stale active-auto.json cannot hide this session's coordinator marker.
confirmed_run() {
    command -v jq >/dev/null 2>&1 || return 1
    printf '%s' "$input" | jq -e . >/dev/null 2>&1 || return 1
    [ -n "$sid" ] || return 1

    payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
    run_kind=""
    for _kind in auto coordinate; do
        project_dir=""
        for _cand in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
            [ -n "$_cand" ] || continue
            if [ -e "$_cand/.ac/state/active-$_kind.json" ]; then
                project_dir="$_cand"
                break
            fi
        done
        [ -n "$project_dir" ] || continue

        marker="$project_dir/.ac/state/active-$_kind.json"
        [ -f "$marker" ] || continue
        jq -e . "$marker" >/dev/null 2>&1 || continue

        marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
        [ "$marker_session" = "$sid" ] || continue
        run_kind="$_kind"
        break
    done
    [ -n "$run_kind" ] || return 1
    if [ "$run_kind" = "coordinate" ]; then
        run_root="coord"
        max_age=259200
        continue_text="$continue_text_coord"
    else
        run_root="auto"
        max_age=86400
        continue_text="$continue_text_auto"
    fi

    now_epoch="$(date -u +%s 2>/dev/null)" || return 1
    started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
    [ -n "$started_at" ] || return 1
    started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
        || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
        || started_epoch=""
    [ -n "$started_epoch" ] || return 1
    age=$((now_epoch - started_epoch))
    # A model-written local time with a trailing Z reads as up to 14h in the future (UTC+14).
    { [ "$age" -ge -50400 ] && [ "$age" -le "$max_age" ]; } || return 1

    # The slug names a directory, so it is checked before any path is built from it.
    slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
    [ -n "$slug" ] || return 1
    case "$slug" in *[!A-Za-z0-9._-]*) return 1 ;; esac
    [ -d "$project_dir/.ac/$run_root/$slug" ] || return 1
    [ ! -e "$project_dir/.ac/$run_root/$slug/verdict.md" ] || return 1

    # An execute marker owned by this session makes every question an execute BLOCKER. One that
    # cannot be read is doubt, so it waits too.
    exec_marker="$project_dir/.ac/state/active-execution.json"
    if [ -e "$exec_marker" ]; then
        exec_session="$(jq -er '.session_id' "$exec_marker" 2>/dev/null)" || return 1
        [ "$exec_session" != "$sid" ] || return 1
    fi

    # A prompt with no question list cannot be classified. One blocker header anywhere makes the
    # whole prompt wait.
    printf '%s' "$input" \
        | jq -e '(.tool_response.questions | type) == "array" and (.tool_response.questions | length) > 0' \
            >/dev/null 2>&1 || return 1
    headers="$(printf '%s' "$input" | jq -r '.tool_response.questions[] | (.header // "")' 2>/dev/null)" || return 1
    crit=""
    premise=""
    while IFS= read -r header; do
        case "$header" in
            'Topic?' | 'Agent fail?' | 'Write fail?' | 'Dep failed?' | 'Halted?' | 'Budget?') return 1 ;;
            'Push?' | 'Lane block?' | 'Conflict?') return 1 ;;
            'Oracle CRIT?') crit=1 ;;
            'Premise failed?') premise=1 ;;
        esac
    done <<EOF
$headers
EOF

    # Oracle CRIT? and Premise failed? each continue once per run, on a counter of their own so one
    # does not spend the other. The key is session, slug and the marker's started_at epoch, so a later
    # run with the same slug in this session starts with a fresh allowance. The exclusive create is the
    # allowance, and it is spent last so a wait for any other reason leaves it intact; noclobber
    # refuses an existing file and a symlink alike.
    if [ -n "$crit" ] || [ -n "$premise" ]; then
        case "$sid" in *[!A-Za-z0-9-]*) return 1 ;; esac
        case "$started_epoch" in '' | *[!0-9]*) return 1 ;; esac
        run_key="$sid-$slug-$started_epoch"
    fi
    if [ -n "$crit" ]; then
        (set -C; : > "${TMPDIR:-/tmp}/ac-question-crit-$run_key") 2>/dev/null || return 1
    fi
    if [ -n "$premise" ]; then
        (set -C; : > "${TMPDIR:-/tmp}/ac-question-premise-$run_key") 2>/dev/null || return 1
    fi
    return 0
}

if confirmed_run; then
    # The run goes on, so a latch from an earlier wait must not keep the Stop guards open.
    [ -n "$have_qw" ] && qw_clear "$sid"
    emit "$continue_text"
fi
wait_for_user
exit 0
