#!/bin/sh
# SessionEnd and SessionStart hook: stop what a session leased through `ac lease add`.
#
# SessionEnd hooks share a 1.5 s budget, and https://code.claude.com/docs/en/hooks.md says
# "Timeouts set on plugin-provided hooks don't raise" it, so the sweep cannot run in the
# foreground: stopping an emulator or a dev server takes longer than that. `lease sweep
# --detach` relaunches itself in a new session with no stdio and returns at once, which keeps
# this script well inside the budget and lets the sweep outlive the claude process.
#
# A SessionEnd never fires on a closed terminal or a crash, and a killed session leaves its
# lease file behind. The SessionStart backstop covers that: on `startup` it runs
# `lease sweep --stale --detach`, which stops every lease whose owning claude process (pid plus
# start time) is gone. A `resume` end is the user switching to another session through
# interactive /resume (hooks.md), and the user chose not to sweep then: the left session's leases
# are stopped at its exit or by the next startup stale sweep.
#
# With the sandbox on, Bash runs with TMPDIR=${CLAUDE_CODE_TMPDIR:-/tmp}/claude-<uid> while hooks
# keep the process TMPDIR, so `lease add` and this hook can see different stores; both candidates
# are checked here and swept by node. When neither holds a relevant file the script exits before
# starting node: a node cold start measured about 630 ms, and SessionEnd hooks share the 1.5 s.
#
# Fail open: prints nothing and exits 0 when jq, node or the bundle is missing, when the
# payload is unreadable, or when the session id or reason is not a plain token.

set -u

command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

bundle="$(dirname "$0")/../cli/ac.js"
[ -f "$bundle" ] || exit 0

# The two candidate stores as positional parameters, so a TMPDIR with a space stays one word.
# They mirror os.tmpdir() (TMPDIR, else /tmp) and the sandbox store in lease.ts.
set -- "${TMPDIR:-/tmp}/ac-leases" "${CLAUDE_CODE_TMPDIR:-/tmp}/claude-$(id -u 2>/dev/null)/ac-leases"

input="$(cat 2>/dev/null)" || exit 0
event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)"

case "$event" in
    SessionEnd)
        session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
        reason="$(printf '%s' "$input" | jq -r '.reason // empty' 2>/dev/null)"
        [ "$reason" = "resume" ] && exit 0

        # The id becomes a file name and an argv word, so it must start alphanumeric and stay a
        # plain token (the same shape lease.ts accepts); anything else is not ours to sweep.
        case "$session" in '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) exit 0 ;; esac
        case "$reason" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

        found=""
        for store in "$@"; do
            [ -f "$store/$session.jsonl" ] && found=1
        done
        [ -n "$found" ] || exit 0

        if [ -n "$reason" ]; then
            node "$bundle" lease sweep --session "$session" --reason "$reason" --detach >/dev/null 2>&1
        else
            node "$bundle" lease sweep --session "$session" --detach >/dev/null 2>&1
        fi
        ;;
    SessionStart)
        source_kind="$(printf '%s' "$input" | jq -r '.source // empty' 2>/dev/null)"
        [ "$source_kind" = "startup" ] || exit 0

        found=""
        for store in "$@"; do
            for file in "$store"/*.jsonl; do
                [ -f "$file" ] && found=1
                break
            done
        done
        [ -n "$found" ] || exit 0

        node "$bundle" lease sweep --stale --detach >/dev/null 2>&1
        ;;
esac

exit 0
