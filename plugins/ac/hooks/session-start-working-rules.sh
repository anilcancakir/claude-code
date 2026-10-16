#!/bin/sh
# SessionStart hook: deliver the ac working rules to the main thread, once.
#
# The rules live between the ac:working-rules markers of references/working-rules.md. Two
# delivery paths exist, and exactly one copy may reach a context: a wrapper launches claude with
# --append-system-prompt-file pointing at the stable copy this hook keeps current, and this hook's
# own additionalContext covers every other launch. A SessionStart payload cannot tell the hook
# which path ran, so the wrapper sets AC_WORKING_RULES_APPENDED=1 and the hook stays silent.
#
# Silent as well when AC_WORKING_RULES=0, when the global CLAUDE.md still carries one of the
# moved headings (old layout, one copy already), and on a resume whose transcript holds the
# earlier copy as a hook_additional_context record (measured on 2.1.301: resume re-fires
# SessionStart and the persisted copy stays in context, so a second emit doubles the rules).
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
if [ "${AC_WORKING_RULES_APPENDED:-}" = "1" ] && appended_here; then
    exit 0
fi

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

# Any hook attachment record carrying the first line counts: the JSON path records
# hook_additional_context, the plain-stdout path records hook_success.
if [ "$(payload_field source)" = "resume" ]; then
    transcript="$(payload_field transcript_path)"
    if [ -n "$transcript" ] && [ -r "$transcript" ] \
        && grep -F '"attachment"' "$transcript" 2>/dev/null | grep -qF '# Working rules (ac plugin)'; then
        exit 0
    fi
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
