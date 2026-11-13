#!/bin/sh
# Wait for a pull request's CI on the head commit this checkout holds, then say whether it is green.
#
# usage: ci-watch.sh [--ignore <regex>] <pr-number> [head-sha]
#        head-sha defaults to `git rev-parse HEAD`. --ignore skips every check whose name matches the
#        extended regex (a review bot that is not a gate); a project names it in its CI section.
#
# Exit codes:
#   0   every check finished and passed (a skipped check counts as passed)
#   1   a check failed or was cancelled; the check table is printed
#   2   CI cannot gate this head: the PR never showed the head, no check ever appeared, or every
#       check sat queued past the limit (a repository with no runner registered)
#   64  bad usage
#
# Why a loop and not `gh pr checks --watch`: a push is invisible to the PR for a few seconds, so
# `--watch` can read the previous head (already green) or fail with "no checks reported"; a job queued
# with no runner never leaves the pending bucket, so `--watch` never returns; and a cancelled check
# exits 0. Run it as `timeout 3600 sh <this file> <pr>`: the bound is what makes the Stop guards count
# it as work that will finish.
#
# Tunables, in seconds: CI_WATCH_INTERVAL (15), CI_WATCH_START_WAIT (120, for the head and the first
# check to appear), CI_WATCH_QUEUE_LIMIT (900, all checks queued and none running).

set -u

ignore=""
if [ "${1:-}" = "--ignore" ]; then
    ignore="${2:-}"
    [ -n "$ignore" ] || { echo "ci-watch: --ignore needs a regex" >&2; exit 64; }
    shift 2
fi
pr="${1:-}"
if [ -z "$pr" ]; then
    echo "usage: ci-watch.sh [--ignore <regex>] <pr-number> [head-sha]" >&2
    exit 64
fi
want="${2:-$(git rev-parse HEAD)}"
interval="${CI_WATCH_INTERVAL:-15}"
start_wait="${CI_WATCH_START_WAIT:-120}"
queue_limit="${CI_WATCH_QUEUE_LIMIT:-900}"

began=$(date +%s)
seen=0
queued_since=""

while :; do
    now=$(date +%s)
    head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid 2>/dev/null)
    checks=""
    if [ "$head" = "$want" ]; then
        checks=$(gh pr checks "$pr" --json bucket,state,name --jq '.[] | [.bucket, .state, .name] | @tsv' 2>/dev/null |
            awk -F '\t' -v re="$ignore" 're == "" || $3 !~ re { print $1 " " $2 }')
    fi

    if [ -z "$checks" ]; then
        # Before the first check appears, silence is a CI that never started; after it, a failed poll
        # is transient and the caller's `timeout` bounds the wait.
        if [ "$seen" -eq 0 ] && [ $((now - began)) -ge "$start_wait" ]; then
            echo "ci-watch: PR #$pr showed no checks for $want after ${start_wait}s (head seen: ${head:-none})" >&2
            exit 2
        fi
    else
        seen=1
        if printf '%s\n' "$checks" | grep -Eq '^(fail|cancel) '; then
            gh pr checks "$pr"
            echo "ci-watch: red on $want" >&2
            exit 1
        fi
        pending=$(printf '%s\n' "$checks" | grep '^pending ')
        if [ -z "$pending" ]; then
            gh pr checks "$pr"
            echo "ci-watch: green on $want${ignore:+ (ignoring checks named /$ignore/)}"
            exit 0
        fi
        if printf '%s\n' "$pending" | grep -Eqv ' (QUEUED|WAITING)$'; then
            queued_since=""
        else
            [ -n "$queued_since" ] || queued_since=$now
            if [ $((now - queued_since)) -ge "$queue_limit" ]; then
                echo "ci-watch: every check on PR #$pr has been queued for ${queue_limit}s; no runner is picking them up" >&2
                exit 2
            fi
        fi
    fi

    sleep "$interval"
done
