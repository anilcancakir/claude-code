#!/bin/sh
# PostToolUse budget for memory files: CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/rules/*.md,
# PROJECT.md and DESIGN.md.
#
# These files are read into every turn that loads them, so each line is paid on every turn. Without a
# budget they only grow: one project reached 33 rule files and 470 KB, one file 706 lines. After a
# Write, Edit or MultiEdit that leaves one of them over budget this hook answers decision:"block",
# which hands the reason to Claude next to the tool result so it consolidates in the same turn; it
# never edits the file itself. Under budget, on any other file, and on any payload it cannot read, it
# prints nothing and exits 0. Auto-memory, vendored trees, references/, installed plugins and the
# skills' own templates under plugins/ac/skills/ are not governed.
#
# Limits, each overridable through the environment (settings.json `env` reaches hooks); 0 turns that
# one check off, and anything that is not a whole number falls back to the default:
#   CLAUDE.md, AGENTS.md   AC_CLAUDE_MD_MAX_LINES 120         AC_CLAUDE_MD_MAX_BYTES 12288
#   CLAUDE.local.md        AC_CLAUDE_LOCAL_MD_MAX_LINES 60    AC_CLAUDE_LOCAL_MD_MAX_BYTES 6144
#   .claude/rules/*.md     AC_RULE_MAX_LINES 120              AC_RULE_MAX_BYTES 12288
#   PROJECT.md             AC_PROJECT_MD_MAX_LINES 150        no byte budget
#   DESIGN.md              AC_DESIGN_MD_MAX_LINES 300         no byte budget
# AC_MEMORY_FILE_BUDGET=0 turns the whole hook off.
#
# These are hard ceilings above the targets ac:claude-md-rules-creator writes to (a rule 15 to 50 lines,
# CLAUDE.local.md 10 to 30): the skill aims low, the hook only stops runaway growth. It stays silent
# when the write did not grow the file (an Edit whose new text is not longer than the old one), so a
# file already over budget is not blocked on every trim or one-line repair; on drafts under
# .ac/init/proposed/ or an ac-init scratch directory; and in a session running /ac:init-project, whose
# own 2d proposal decides what stays and already reports any overage.

set -u

# Echo $1 when it is a whole number, otherwise the default in $2.
limit() {
    case "$1" in
        '' | *[!0-9]*) printf '%s' "$2" ;;
        *) printf '%s' "$1" ;;
    esac
}

[ "${AC_MEMORY_FILE_BUDGET:-}" = "0" ] && exit 0

# 0. Read the payload. jq is the only parser; without it, or without a payload, allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
[ -n "$file" ] || exit 0

case "$file" in
    */.ac/init/proposed/* | */ac-init-*) exit 0 ;;
esac

# An Edit or MultiEdit that removed at least as much as it added did not grow the file.
grew="$(printf '%s' "$input" | jq -r '
    if .tool_name == "Edit" then ((.tool_input.new_string // "") | length) > ((.tool_input.old_string // "") | length)
    elif .tool_name == "MultiEdit" then ([.tool_input.edits[]? | (.new_string // "" | length) - (.old_string // "" | length)] | add // 0) > 0
    else true end' 2>/dev/null)" || grew=true
[ "$grew" = "false" ] && exit 0

transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"
if [ -n "$transcript" ] && [ -r "$transcript" ] \
    && grep -F '"role":"user","content":"<command-' "$transcript" 2>/dev/null \
        | grep -q -E '"role":"user","content":"<command-(message>|name>/)ac:init-project</command-'; then
    exit 0
fi

# 1. Pick the budget for the file; every other write passes untouched.
case "$file" in
    */.claude/projects/* | */node_modules/* | */vendor/* | */references/* | */.claude/plugins/* | \
        */plugins/ac/skills/*)
        exit 0
        ;;
esac

case "$file" in
    */.claude/rules/*.md)
        skill="ac:claude-md-rules-creator"
        max_lines="$(limit "${AC_RULE_MAX_LINES:-}" 120)"
        max_bytes="$(limit "${AC_RULE_MAX_BYTES:-}" 12288)"
        ;;
    *)
        case "${file##*/}" in
            CLAUDE.md | AGENTS.md)
                skill="ac:claude-md-rules-creator"
                max_lines="$(limit "${AC_CLAUDE_MD_MAX_LINES:-}" 120)"
                max_bytes="$(limit "${AC_CLAUDE_MD_MAX_BYTES:-}" 12288)"
                ;;
            CLAUDE.local.md)
                skill="ac:claude-md-rules-creator"
                max_lines="$(limit "${AC_CLAUDE_LOCAL_MD_MAX_LINES:-}" 60)"
                max_bytes="$(limit "${AC_CLAUDE_LOCAL_MD_MAX_BYTES:-}" 6144)"
                ;;
            PROJECT.md)
                skill="ac:project-md-writer"
                max_lines="$(limit "${AC_PROJECT_MD_MAX_LINES:-}" 150)"
                max_bytes=0
                ;;
            DESIGN.md)
                skill="ac:design-md-writer"
                max_lines="$(limit "${AC_DESIGN_MD_MAX_LINES:-}" 300)"
                max_bytes=0
                ;;
            *) exit 0 ;;
        esac
        ;;
esac
[ -f "$file" ] || exit 0

# 2. Measure the file as the CLI will load it.
# awk rather than wc -l, which misses a last line that has no trailing newline.
lines="$(awk 'END { print NR }' "$file" 2>/dev/null)" || exit 0
bytes="$(wc -c < "$file" | tr -d ' ')" || exit 0

over=""
[ "$max_lines" -gt 0 ] && [ "$lines" -gt "$max_lines" ] && over=1
[ "$max_bytes" -gt 0 ] && [ "$bytes" -gt "$max_bytes" ] && over=1
[ -n "$over" ] || exit 0

# 3. Over budget: say exactly what to fix and how, without deleting anything.
if [ "$max_lines" -gt 0 ]; then
    measured="${lines}/${max_lines} lines"
else
    measured="${lines} lines"
fi
if [ "$max_bytes" -gt 0 ]; then
    measured="${measured}, ${bytes}/${max_bytes} bytes"
else
    measured="${measured}, ${bytes} bytes"
fi

reason="${file##*/} is over its budget (${measured}): ${file}."
reason="${reason} Consolidate it now, before continuing, following ${skill}: cut every line the next agent"
reason="${reason} would not get wrong without it or could read from the code, keep one home per fact (delete"
reason="${reason} duplicates of the root CLAUDE.md or another rule), move file-specific content into a"
reason="${reason} .claude/rules file scoped with paths:, and move long reference material into a doc the file"
reason="${reason} points at. A rule file records invariants, not a change history: drop dated narratives and"
reason="${reason} incident logs. Do not delete a fact you have not moved."

jq -n --arg reason "$reason" '{decision: "block", reason: $reason}' 2>/dev/null
exit 0
