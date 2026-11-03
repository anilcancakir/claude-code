#!/bin/sh
# SessionEnd, SessionStart and Stop hook: stop what a session leased through `ac lease add`, and
# reap test runners a killed session left behind.
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
# A Bash timeout or a killed session leaves its test runners (flutter_tester, phpunit, bun test and
# the like) reparented to launchd, where they ran for 16 to 21 hours. On `startup` and on every
# `Stop`, `reap_candidate` looks for one: a single `ps` piped to a single `awk`, owned by this user,
# ppid 1, a test runner as the command and an elapsed time of at least 30 minutes (the default of
# `lease reap --min-age`). Only a hit starts node, as `lease reap --detach`, which matches again and
# does the signalling. Stop fires on every turn end in every session, so the
# pre-check must stay that cheap and must exit 0 whatever happens: a Stop hook that errors or blocks
# would interfere with the four stop guards.
#
# Fail open: prints nothing and exits 0 when jq, node or the bundle is missing, when the
# payload is unreadable, or when the session id or reason is not a plain token.

set -u

command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

bundle="$(dirname "$0")/../cli/ac.js"
[ -f "$bundle" ] || exit 0

# The same patterns as TEST_RUNNER_PATTERNS in lease.ts, matched on the command column alone: a
# looser prefilter would start node on every turn end for an orphan the exact list then rejects.
# etime is [[dd-]hh:]mm:ss, so more than two parts, or a minutes part of 30 or more, is 30 minutes.
reap_candidate() {
    command -v ps >/dev/null 2>&1 || return 1
    command -v awk >/dev/null 2>&1 || return 1
    ps -U "$(id -u 2>/dev/null)" -ww -o ppid=,etime=,command= 2>/dev/null | awk '
        $1 == 1 {
            command = $0
            sub(/^[ \t]*[0-9]+[ \t]+[^ \t]+[ \t]+/, "", command)
            if (command !~ /^[^ ]*\/flutter_tester( |$)|^[^ ]*\/dart(aotruntime)?( +-[^ ]+)* +[^ ]*flutter_tools\.snapshot +test( |$)|^([^ ]*\/)?dart +test( |$)|^([^ ]*\/)?php[^ \/]*( +[^ ]+)* +artisan +test( |$)|^(([^ ]*\/)?php[^ \/]*( +[^ ]+)* +)?([^ ]*\/)?vendor\/bin\/(phpunit|pest|paratest)( |$)|^([^ ]*\/)?php[^ \/]*( +[^ ]+)* +[^ ]*paratest\/bin\/phpunit-wrapper|^([^ ]*\/)?bun +test( |$)|^(([^ ]*\/)?node( +-[^ ]+)* +)?[^ ]*\/(vitest|jest)(\.m?js)?( |$)|^(([^ ]*\/)?node( +-[^ ]+)* +)?([^ ]*\/)?playwright +test( |$)/) next
            parts = split($2, age, /[-:]/)
            if (parts > 2 || age[1] + 0 >= 30) { found = 1; exit }
        }
        END { exit found ? 0 : 1 }
    '
}

reap_orphans() {
    if reap_candidate; then
        node "$bundle" lease reap --detach >/dev/null 2>&1
    fi
}

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
        if [ -n "$found" ]; then
            node "$bundle" lease sweep --stale --detach >/dev/null 2>&1
        fi

        reap_orphans
        ;;
    Stop)
        reap_orphans
        ;;
esac

exit 0
