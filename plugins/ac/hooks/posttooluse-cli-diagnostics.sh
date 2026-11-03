#!/bin/sh
# PostToolUse ground truth for Dart and PHP edits.
#
# Claude Code's LSP client only syncs the changes Edit and Write make; it never sends
# didChangeWatchedFiles, so a change from Bash, git, a formatter or another session never reaches the
# language server. It also delivers diagnostics a turn late and shows each one once, so what the model
# reads is often stale in both directions (anthropics/claude-code #93321, #76870, #85225, #100569).
# After a Write, Edit or MultiEdit of a .dart or .php file this hook runs the command-line analyzer
# on that one file and hands the result to Claude as additionalContext in the same turn: dart analyze
# --fatal-infos for Dart (most flutter_lints rules are info level, and dart exits 0 on infos without
# the flag); php -l for PHP, plus phpstan when the nearest composer.json directory ships
# vendor/bin/phpstan. php -l checks syntax only, so without phpstan the hook says so instead of
# calling a type or symbol diagnostic stale. It informs and never blocks, prints nothing for any other file, and fails open
# on a missing tool, an unreadable payload or a timeout it cannot report.
#
# It is built to stay out of the way when several sessions work at once. A cold `dart analyze` starts an
# analysis server of 500 to 700 MB, and in a fresh git worktree that run often outlives any sensible limit
# (in the author's transcripts the timeouts cluster in `.claude/worktrees`). So:
#   - it runs on the main thread only. A subagent worker already runs the file's analyzer itself before it
#     reports done (references/verification.md), so a hook run per edit doubled the work;
#   - dart analyze and phpstan each run one at a time on the machine, whatever the number of sessions: a
#     run that cannot get the slot within the wait says so and skips;
#   - a run that times out puts its project root on a back-off, because the next run would be just as cold;
#   - a Dart file whose package has no resolved packages is skipped, as in a worktree before `pub get`: the
#     package's own .dart_tool/package_config.json is required, or for a pub workspace member (`resolution:
#     workspace`) the workspace root's, found without leaving the checkout (the first directory holding a
#     .git entry). Anything looser lets a worktree nested under .claude/worktrees, or an `example/` package,
#     borrow a parent's config and be judged against the parent's code;
#   - the tool runs at nice 10 inside its own process group, and the whole group is ended on a timeout and
#     after a normal exit (hooks/lib/run-bounded.pl), so no analysis server is left behind. Known limit: if
#     the runner itself is SIGKILLed (jetsam, kill -9) its group runs on unbounded; Claude Code's own hook
#     timeout kill walks the process tree, so the usual way a hook dies is covered.
#
# Cost measured on the author's machine on 2026-10-31: dart analyze <file> about 1.5 s, php -l about
# 0.2 s; phpstan depends on the project.
#
# Knobs, read from the environment (settings.json `env` reaches hooks):
#   AC_CLI_DIAGNOSTICS=0           turns the hook off
#   AC_CLI_DIAGNOSTICS_TIMEOUT     seconds each tool may run, default 15, at most 20; 0 or not a whole number:
#                                  default (a zero limit would mean no limit and let the hook timeout kill it).
#                                  The cap keeps php -l, the slot wait and phpstan inside the 60 s registration
#   AC_CLI_DIAGNOSTICS_WAIT        seconds to wait for the dart or phpstan slot, default 5, at most 10; 0 never
#                                  waits
#   AC_CLI_DIAGNOSTICS_BACKOFF     seconds a project is left alone after a timeout, default 180; 0 never
#   AC_CLI_DIAGNOSTICS_SUBAGENTS=1 runs the hook inside subagents too

set -u

# Echo $1 when it is a whole number, otherwise the default in $2. Leading zeros go: shell arithmetic reads
# 09 as a bad octal number and would abort the hook.
limit() {
    case "$1" in
        '' | *[!0-9]*) printf '%s' "$2" ;;
        *)
            digits="${1#"${1%%[!0]*}"}"
            printf '%s' "${digits:-0}"
            ;;
    esac
}

[ "${AC_CLI_DIAGNOSTICS:-}" = "0" ] && exit 0
secs="$(limit "${AC_CLI_DIAGNOSTICS_TIMEOUT:-}" 15)"
[ "$secs" -gt 0 ] || secs=15
[ "$secs" -le 20 ] || secs=20
wait_secs="$(limit "${AC_CLI_DIAGNOSTICS_WAIT:-}" 5)"
[ "$wait_secs" -le 10 ] || wait_secs=10
backoff="$(limit "${AC_CLI_DIAGNOSTICS_BACKOFF:-}" 180)"

# 0. Read the payload. jq is the only parser; without it, or without a payload, allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v perl >/dev/null 2>&1 || exit 0
runner="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/lib/run-bounded.pl"
[ -f "$runner" ] || exit 0

# A subagent payload carries agent_id; a worker runs the analyzer itself, so stay out of its way.
if [ "${AC_CLI_DIAGNOSTICS_SUBAGENTS:-}" != "1" ]; then
    agent="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)" || exit 0
    [ -z "$agent" ] || exit 0
fi

file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

# Print the nearest directory at or above $1 that holds a file named $2; fail when there is none.
find_up() {
    dir="$1"
    while :; do
        if [ -f "$dir/$2" ]; then
            printf '%s' "$dir"
            return 0
        fi
        { [ "$dir" = "/" ] || [ "$dir" = "." ]; } && return 1
        dir="$(dirname "$dir")"
    done
}

# Like find_up, but the walk ends at the first directory holding a .git entry (a file in a worktree, a
# directory in a checkout), after looking in it. What lies above the checkout is not this project's.
find_up_in_checkout() {
    dir="$1"
    while :; do
        if [ -f "$dir/$2" ]; then
            printf '%s' "$dir"
            return 0
        fi
        [ -e "$dir/.git" ] && return 1
        { [ "$dir" = "/" ] || [ "$dir" = "." ]; } && return 1
        dir="$(dirname "$dir")"
    done
}

# Succeed when the Dart package at $1 has its packages resolved: its own .dart_tool/package_config.json, or,
# for a member of a pub workspace (`resolution: workspace`), the workspace root's inside the same checkout.
# A package that has not run `pub get` must not borrow the config of a parent package it does not belong to.
dart_resolved() {
    [ -f "$1/.dart_tool/package_config.json" ] && return 0
    grep -q '^resolution:[[:space:]]*workspace' "$1/pubspec.yaml" 2>/dev/null || return 1
    find_up_in_checkout "$(dirname "$1")" .dart_tool/package_config.json >/dev/null
}

nl='
'
ctx="CLI check for ${file}:"
clean_all=1
found_issues=0
# 1 once a tool that checks types and symbols ran; php -l alone leaves it at 0.
semantic=0

state="${TMPDIR:-/tmp}"
state="${state%/}"
held=""

# Give the slot back, but only while it still names this hook: a slot reaped as stale and taken by another
# hook is not ours to delete. Safe to call twice.
release() {
    if [ -n "$held" ] && [ "$(cat "$held/pid" 2>/dev/null)" = "$$" ]; then
        rm -rf "$held"
    fi
    held=""
}
trap release EXIT
trap 'release; exit 0' INT TERM HUP

# Take the machine-wide slot named $1, waiting up to $wait_secs. The slot is a directory holding the
# owner's pid; it is reaped when that pid is gone or the directory is older than a run can be, so a hook
# that was killed does not block the others. Two waiters reaping at once can both get in; the limit is
# best effort and that only costs one extra analysis.
acquire() {
    lock="$state/ac-cli-diagnostics-$1.lock"
    ttl=$(((secs + 30) / 60 + 1))
    waited=0
    reaps=0
    while :; do
        if mkdir "$lock" 2>/dev/null; then
            printf '%s' "$$" >"$lock/pid"
            held="$lock"
            return 0
        fi
        holder="$(cat "$lock/pid" 2>/dev/null)"
        if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ -n "$(find "$lock" -maxdepth 0 -mmin "+$ttl" 2>/dev/null)" ]; then
            reaps=$((reaps + 1))
            [ "$reaps" -le 3 ] || return 1
            rm -rf "$lock"
            continue
        fi
        [ "$waited" -lt "$wait_secs" ] || return 1
        sleep 1
        waited=$((waited + 1))
    done
}

# Run "$@" from directory $1 under the limit; sets $out and $status. A timeout reads as status 142.
run() {
    run_dir="$1"
    shift
    out="$(cd "$run_dir" && perl "$runner" "$secs" "$@" 2>&1)"
    status=$?
}

# Run "$@" from directory $2 like run(), but one at a time on the machine (slot $1) and not at all while
# the project is on its back-off. Returns 0 when it ran, 1 when the slot stayed taken, 2 when backed off.
heavy() {
    slot="$1"
    heavy_dir="$2"
    shift 2
    marker="$state/ac-cli-diagnostics-backoff-$slot-$(printf '%s' "$heavy_dir" | cksum | cut -d' ' -f1)"
    if [ "$backoff" -gt 0 ] && [ -f "$marker" ]; then
        age="$(perl -e 'print time - (stat shift)[9]' "$marker" 2>/dev/null)"
        case "$age" in
            '' | *[!0-9]*) ;;
            *) [ "$age" -lt "$backoff" ] && return 2 ;;
        esac
    fi
    acquire "$slot" || return 1
    run "$heavy_dir" "$@"
    release
    if [ "$status" -eq 142 ]; then
        [ "$backoff" -gt 0 ] && : >"$marker"
    else
        rm -f "$marker"
    fi
    return 0
}

# Append one tool's verdict to $ctx from the $out and $status of the last run(); $1 names the tool.
report() {
    if [ "$status" -eq 142 ]; then
        ctx="${ctx}${nl}$1: timed out after ${secs}s; run it yourself before trusting or dismissing an LSP diagnostic on this file"
        if [ "$backoff" -gt 0 ] && [ "${2:-}" = "heavy" ]; then
            ctx="${ctx}${nl}Checks of this project are paused for ${backoff}s."
        fi
        clean_all=0
        return
    fi
    if [ "$status" -eq 0 ]; then
        ctx="${ctx}${nl}$1: clean"
        return
    fi

    clean_all=0
    found_issues=1
    body="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | grep -v '^Analyzing ' | grep -v '^Note: Using configuration file')"
    if [ -z "$body" ]; then
        ctx="${ctx}${nl}$1: failed with exit status ${status} and no output"
        return
    fi

    total="$(printf '%s\n' "$body" | wc -l | tr -d ' ')"
    noun="issue lines"
    [ "$total" -eq 1 ] && noun="issue line"
    ctx="${ctx}${nl}$1: ${total} ${noun}${nl}$(printf '%s\n' "$body" | head -n 20)"
    [ "$total" -gt 20 ] && ctx="${ctx}${nl}... ($((total - 20)) more)"
}

# Say that tool $1 did not run because another check holds the slot.
busy() {
    ctx="${ctx}${nl}$1: skipped, another check holds the machine-wide slot; run it yourself if you need ground truth for this file"
    clean_all=0
}

# 1. Pick the branch by extension; anything else is not ours.
case "$file" in
    *.dart)
        command -v dart >/dev/null 2>&1 || exit 0
        root="$(find_up "$(dirname "$file")" pubspec.yaml)" || exit 0
        dart_resolved "$root" || exit 0
        heavy dart "$root" dart analyze --fatal-infos "$file"
        case $? in
            0) report "dart analyze --fatal-infos" heavy ;;
            1) busy "dart analyze --fatal-infos" ;;
            *) exit 0 ;;
        esac
        semantic=1
        ;;
    *.php)
        command -v php >/dev/null 2>&1 || exit 0
        run "$(dirname "$file")" php -l "$file"
        report "php -l"
        # phpstan only where the project installed it; a global one would judge by the wrong config.
        root="$(find_up "$(dirname "$file")" composer.json)"
        if [ -n "$root" ] && [ -x "$root/vendor/bin/phpstan" ]; then
            heavy phpstan "$root" vendor/bin/phpstan analyse --no-progress --error-format=raw "$file"
            case $? in
                0)
                    report "vendor/bin/phpstan analyse" heavy
                    semantic=1
                    ;;
                1) busy "vendor/bin/phpstan analyse" ;;
            esac
        fi
        ;;
    *) exit 0 ;;
esac

# 2. Say what the verdicts mean for the LSP's version of the file.
if [ "$found_issues" -eq 1 ]; then
    ctx="${ctx}${nl}These are current; fix them or say why not."
elif [ "$clean_all" -eq 1 ] && [ "$semantic" -eq 1 ]; then
    ctx="${ctx}${nl}LSP diagnostics on this file that disagree with this are stale."
elif [ "$clean_all" -eq 1 ]; then
    ctx="${ctx}${nl}php -l checks syntax only; it cannot confirm or refute a type or symbol diagnostic, so read the code such a diagnostic names before you fix or dismiss it."
fi

jq -n --arg ctx "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null
exit 0
