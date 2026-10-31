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
# on a missing tool, an unreadable payload or a timeout it cannot report. It fires inside subagents
# too, since the PostToolUse matcher does not filter on the agent.
#
# Cost measured on the author's machine on 2026-10-31: dart analyze <file> about 1.5 s, php -l about
# 0.2 s; phpstan depends on the project.
#
# Knobs, read from the environment (settings.json `env` reaches hooks):
#   AC_CLI_DIAGNOSTICS=0           turns the hook off
#   AC_CLI_DIAGNOSTICS_TIMEOUT     seconds each tool may run, default 20; 0 or not a whole number: default
#                                  (perl's alarm 0 would disable the limit and let the hook timeout kill it)

set -u

# Echo $1 when it is a whole number, otherwise the default in $2.
limit() {
    case "$1" in
        '' | *[!0-9]*) printf '%s' "$2" ;;
        *) printf '%s' "$1" ;;
    esac
}

[ "${AC_CLI_DIAGNOSTICS:-}" = "0" ] && exit 0
secs="$(limit "${AC_CLI_DIAGNOSTICS_TIMEOUT:-}" 20)"
[ "$secs" -gt 0 ] || secs=20

# 0. Read the payload. jq is the only parser; without it, or without a payload, allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v perl >/dev/null 2>&1 || exit 0

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

nl='
'
ctx="CLI check for ${file}:"
clean_all=1
found_issues=0
# 1 once a tool that checks types and symbols ran; php -l alone leaves it at 0.
semantic=0

# Run "$@" from directory $1 under the alarm; sets $out and $status. macOS has no timeout binary, so
# perl's alarm stands in: a SIGALRM kill reads as status 142.
run() {
    run_dir="$1"
    shift
    out="$(cd "$run_dir" && perl -e 'alarm shift; exec @ARGV' "$secs" "$@" 2>&1)"
    status=$?
}

# Append one tool's verdict to $ctx from the $out and $status of the last run(); $1 names the tool.
report() {
    if [ "$status" -eq 142 ]; then
        ctx="${ctx}${nl}$1: timed out after ${secs}s; run it yourself before trusting or dismissing an LSP diagnostic on this file"
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

# 1. Pick the branch by extension; anything else is not ours.
case "$file" in
    *.dart)
        command -v dart >/dev/null 2>&1 || exit 0
        root="$(find_up "$(dirname "$file")" pubspec.yaml)" || exit 0
        run "$root" dart analyze --fatal-infos "$file"
        report "dart analyze --fatal-infos"
        semantic=1
        ;;
    *.php)
        command -v php >/dev/null 2>&1 || exit 0
        run "$(dirname "$file")" php -l "$file"
        report "php -l"
        # phpstan only where the project installed it; a global one would judge by the wrong config.
        root="$(find_up "$(dirname "$file")" composer.json)"
        if [ -n "$root" ] && [ -x "$root/vendor/bin/phpstan" ]; then
            run "$root" vendor/bin/phpstan analyse --no-progress --error-format=raw "$file"
            report "vendor/bin/phpstan analyse"
            semantic=1
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
