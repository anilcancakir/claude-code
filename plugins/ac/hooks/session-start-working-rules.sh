#!/bin/sh
# SessionStart hook: deliver the ac working rules to the main thread, once.
#
# The rules live between the ac:working-rules markers of references/working-rules.md. Two
# delivery paths exist, and exactly one copy may reach a context: a wrapper launches claude with
# --append-system-prompt-file pointing at the stable copy this hook keeps current, and this hook's
# own additionalContext covers every other launch. A SessionStart payload cannot tell the hook
# which path ran, so on a fresh startup the wrapper's AC_WORKING_RULES_APPENDED=1, checked
# against the claude process's own arguments, keeps the hook silent.
#
# Outside a startup the transcript decides instead, because a resume restores the session's
# first system prompt and ignores the new launch's flags: the latest prompt_snapshot carries the
# rules or it does not, and on a resume a hook copy still in context counts too. Silent as well
# when AC_WORKING_RULES=0 or when the global CLAUDE.md still carries two or more moved headings
# (old layout, one copy already).
#
# Fail open, and never silent because of a missing tool: without jq the text goes out as plain
# stdout, which an exit-0 SessionStart hook delivers as context too. Exits 0 on every path.

set -u

rules="$(dirname "$0")/../references/working-rules.md"
text="$(awk '
    /^<!-- ac:working-rules:end -->$/ { on = 0 }
    on { print }
    /^<!-- ac:working-rules:start -->$/ { on = 1 }
' "$rules" 2>/dev/null)"
[ -n "$text" ] || exit 0

# 1. Keep the stable copy a wrapper appends current. Same-directory temp plus mv, so a
#    concurrent launch never reads a half-written file; skip the write when nothing changed.
stable_dir="${AC_WORKING_RULES_DIR:-$HOME/.claude/ac}"
stable="$stable_dir/working-rules.md"
if mkdir -p "$stable_dir" 2>/dev/null; then
    tmp="$stable_dir/.working-rules.md.$$"
    printf '%s\n' "$text" >"$tmp" 2>/dev/null
    if cmp -s "$tmp" "$stable" 2>/dev/null; then
        rm -f "$tmp"
    else
        mv -f "$tmp" "$stable" 2>/dev/null || rm -f "$tmp"
    fi
fi

# 2. Stay silent when another copy of the rules already reaches this context.
[ "${AC_WORKING_RULES:-}" = "0" ] && exit 0

# The variable is inherited by every process the wrapped session starts, so a nested `claude` run
# from its Bash tool would read it too while carrying no append file. Trust it only when the nearest
# `claude` ancestor passed --append-system-prompt-file, or when the process table cannot be read.
appended_here() {
    pid=$PPID
    depth=0
    while [ "$depth" -lt 6 ] && [ -n "$pid" ] && [ "$pid" != "0" ]; do
        args="$(ps -ww -o args= -p "$pid" 2>/dev/null)" || return 0
        case "${args%% *}" in
            claude|*/claude)
                case "$args" in
                    *--append-system-prompt-file*) return 0 ;;
                    *) return 1 ;;
                esac
                ;;
        esac
        pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" || return 0
        depth=$((depth + 1))
    done
    return 0
}

# Old layout: an /ac:install from before the move left the eight workflow sections in CLAUDE.md, so
# one copy already reaches the context. Two headings are required because a user may well have
# written one generic `## Decisions` of their own.
moved='## (Reading the request|Grounding|Decisions|Research and review|Plan or work directly'
moved="$moved|Web research|Run to completion|Before you call it done)"
global_md="${AC_GLOBAL_CLAUDE_MD:-$HOME/.claude/CLAUDE.md}"
if [ -f "$global_md" ] && [ "$(grep -cxE "$moved" "$global_md" 2>/dev/null)" -ge 2 ]; then
    exit 0
fi

input="$(cat 2>/dev/null)"
payload_field() {
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$input" | jq -r --arg key "$1" '.[$key] // empty' 2>/dev/null
        return
    fi
    # Without jq, a plain match: good enough for the two string fields read here.
    printf '%s' "$input" | awk -v key="$1" '
        match($0, "\"" key "\" *: *\"[^\"]*\"") {
            s = substr($0, RSTART, RLENGTH)
            sub("^\"" key "\" *: *\"", "", s)
            sub("\"$", "", s)
            print s
            exit
        }'
}

source_kind="$(payload_field source)"
transcript="$(payload_field transcript_path)"
[ -n "$transcript" ] && [ -r "$transcript" ] || transcript=""

# A copy this hook delivered earlier and that a resume still loads: a hook_additional_context
# (JSON path) or hook_success (plain stdout) record carrying the first line, after the last
# compaction boundary. Any other record that merely quotes the line, such as a subagent result in
# a task notification, does not count.
hook_copy_in_context() {
    awk '/"subtype":"compact_boundary"/ { found = 0 }
         /"type":"(hook_additional_context|hook_success)"/ && index($0, "# Working rules (ac plugin)") { found = 1 }
         END { exit !found }' "$transcript" 2>/dev/null
}

# Measured on 2.1.301 and 2.1.302: --resume and -c restore the session's first system prompt from
# its prompt_snapshot record and ignore the new launch's append flags, so a session first opened
# without the wrapper has no rules in its system prompt however it is resumed. Outside a fresh
# startup the latest snapshot decides: it carries the rules (silent), or it does not and only a
# hook copy still in context keeps the hook silent; the wrapper variable is not consulted. With
# no snapshot to read, fall through to the wrapper check.
if [ "$source_kind" != "startup" ] && [ -n "$transcript" ]; then
    snapshot="$(grep -aF '"prompt_snapshot"' "$transcript" 2>/dev/null | tail -n 1)"
    case "$snapshot" in
        *'# Working rules (ac plugin)'*) exit 0 ;;
    esac
    if [ "$source_kind" = "resume" ] && hook_copy_in_context; then
        exit 0
    fi
    [ -n "$snapshot" ] && appended_check=skip
fi

if [ "${appended_check:-}" != "skip" ] && [ "${AC_WORKING_RULES_APPENDED:-}" = "1" ] && appended_here; then
    exit 0
fi

# 3. Emit.
if command -v jq >/dev/null 2>&1; then
    jq -cn --arg c "$text" '{
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: $c
      }
    }'
else
    printf '%s\n' "$text"
fi
exit 0
