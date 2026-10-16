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
[ "${AC_WORKING_RULES_APPENDED:-}" = "1" ] && exit 0

global_md="${AC_GLOBAL_CLAUDE_MD:-$HOME/.claude/CLAUDE.md}"
if [ -f "$global_md" ] && grep -qxE '## (Reading the request|Grounding|Decisions|Research and review|Plan or work directly|Web research|Run to completion|Before you call it done)' "$global_md" 2>/dev/null; then
    exit 0
fi

# awk, not jq, reads the payload: this runs on the path where jq may be absent.
input="$(cat 2>/dev/null)"
payload_field() {
    printf '%s' "$input" | awk -v key="$1" '
        match($0, "\"" key "\" *: *\"[^\"]*\"") {
            s = substr($0, RSTART, RLENGTH)
            sub("^\"" key "\" *: *\"", "", s)
            sub("\"$", "", s)
            print s
            exit
        }'
}

if [ "$(payload_field source)" = "resume" ]; then
    transcript="$(payload_field transcript_path)"
    if [ -n "$transcript" ] && [ -r "$transcript" ] \
        && grep -F 'hook_additional_context' "$transcript" 2>/dev/null | grep -qF '# Working rules (ac plugin)'; then
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
