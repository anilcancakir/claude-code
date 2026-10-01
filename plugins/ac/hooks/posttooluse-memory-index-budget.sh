#!/bin/sh
# PostToolUse budget for the auto-memory index.
#
# Claude Code loads the first 200 lines or 25KB of a project's auto-memory MEMORY.md into every
# session of that project and leaves the rest out, so each line is paid on every turn. Claude Code
# itself only steps in near that cap; this hook holds the index to a budget well below it, where
# the index stays a list of one-line pointers. It covers the default layout,
# <config dir>/projects/<project>/memory/MEMORY.md, and not a directory moved by
# autoMemoryDirectory. After a Write, Edit or MultiEdit that leaves MEMORY.md over budget it answers
# decision:"block", which hands the reason to Claude next to the tool result so it consolidates
# in the same turn; it never edits the file itself. Under budget, and on any payload it cannot
# read, it prints nothing and exits 0.
#
# Limits, each overridable through the environment (settings.json `env` reaches hooks); 0 turns
# that one check off, and anything that is not a whole number falls back to the default:
#   AC_MEMORY_INDEX_MAX_LINES       80
#   AC_MEMORY_INDEX_MAX_BYTES       10240
#   AC_MEMORY_INDEX_MAX_LINE_BYTES  150

set -u

# Echo $1 when it is a whole number, otherwise the default in $2.
limit() {
    case "$1" in
        '' | *[!0-9]*) printf '%s' "$2" ;;
        *) printf '%s' "$1" ;;
    esac
}

max_lines="$(limit "${AC_MEMORY_INDEX_MAX_LINES:-}" 80)"
max_bytes="$(limit "${AC_MEMORY_INDEX_MAX_BYTES:-}" 10240)"
max_line_bytes="$(limit "${AC_MEMORY_INDEX_MAX_LINE_BYTES:-}" 150)"

# 0. Read the payload. jq is the only parser; without it, or without a payload, allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0

# 1. Only the auto-memory index matters; every other write, a repository's own memory/MEMORY.md
#    included, passes untouched.
case "$file" in
    */projects/*/memory/MEMORY.md) ;;
    *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

# 2. Measure the file as the CLI will load it. LC_ALL=C makes awk count bytes, and the limit is
#    stated to Claude in bytes too: a Turkish letter is two, so a line that looks short enough
#    would otherwise keep failing.
# awk rather than wc -l, which misses a last line that has no trailing newline.
lines="$(awk 'END { print NR }' "$file" 2>/dev/null)" || exit 0
bytes="$(wc -c < "$file" | tr -d ' ')" || exit 0
long=""
if [ "$max_line_bytes" -gt 0 ]; then
    long="$(LC_ALL=C awk -v max="$max_line_bytes" \
        'length($0) > max { printf "%s%d", sep, NR; sep = "," }' "$file" 2>/dev/null)" || exit 0
fi

over=""
[ "$max_lines" -gt 0 ] && [ "$lines" -gt "$max_lines" ] && over=1
[ "$max_bytes" -gt 0 ] && [ "$bytes" -gt "$max_bytes" ] && over=1
[ -n "$long" ] && over=1
[ -n "$over" ] || exit 0

# 3. Over budget: say exactly what to fix and how, without deleting anything.
reason="MEMORY.md is over its budget (${lines}/${max_lines} lines, ${bytes}/${max_bytes} bytes"
[ -n "$long" ] && reason="${reason}; lines over ${max_line_bytes} bytes: ${long}"
reason="${reason}): ${file}."
reason="${reason} Consolidate it now, before continuing. Shorten each pointer to one hook of at most"
reason="${reason} ${max_line_bytes} bytes (non-ASCII letters count as two); merge pointers to duplicate or"
reason="${reason} superseded memories (fold the surviving facts into one topic file first); and when a theme"
reason="${reason} holds many entries, move them to a sub-index file named _index-<theme>.md in the same"
reason="${reason} directory, with frontmatter (name, description listing its keywords, metadata.type:"
reason="${reason} reference), leaving one line in MEMORY.md that names the theme and its keywords. New"
reason="${reason} memories on a theme that has a sub-index go into that sub-index. Never delete a topic file"
reason="${reason} whose facts you have not carried over."

jq -n --arg reason "$reason" '{decision: "block", reason: $reason}' 2>/dev/null
exit 0
