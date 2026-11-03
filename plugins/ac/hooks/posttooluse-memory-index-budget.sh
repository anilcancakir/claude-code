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
#   AC_MEMORY_NOTE_MAX_LINES        40
#   AC_MEMORY_NOTE_MAX_BYTES        3072
#
# The same hook also bounds topic notes, <config dir>/projects/<project>/memory/<name>.md for any
# name but MEMORY.md and the _index-<theme>.md sub-indexes (those are the overflow the MEMORY.md block asks for, so a
# pointer list is not condensed to one fact). A note is read in full
# whenever a session opens it, and a long one is usually a log, an audit or a runbook that belongs in
# the repository. Past the two NOTE limits the block reason tells Claude to condense it to one
# durable fact. Only a write that grew the file counts: an Edit or MultiEdit whose new text is not
# longer than the old one passes, so an already-long note can be trimmed or repaired.
#
# Hysteresis: within one session a file that is still over budget is blocked again only when it is
# larger (lines or bytes) than at its last block, and every reason asks for about 90% of the cap.
# State is one file per session and path under ${TMPDIR:-/tmp}, removed once the file is within budget.

set -u

# Echo $1 when it is a whole number, otherwise the default in $2.
limit() {
    case "$1" in
        '' | *[!0-9]*) printf '%s' "$2" ;;
        *) printf '%s' "$1" ;;
    esac
}

# Hysteresis, so a file hovering just over its cap is not blocked on every edit while the model
# shrinks it. $state is keyed by session and path under TMPDIR (never the user's repository) and
# holds the lines and bytes measured at the last block; empty when the payload has no session id,
# in which case every over-budget write blocks.

# Succeeds when lines $1 and bytes $2 are both at or below the last block's.
no_larger() {
    [ -n "$state" ] && [ -f "$state" ] || return 1
    prev="$(cat "$state" 2>/dev/null)"
    prev_lines="${prev%% *}"
    prev_bytes="${prev##* }"
    case "${prev_lines}${prev_bytes}" in
        '' | *[!0-9]*) return 1 ;;
    esac
    [ "$1" -le "$prev_lines" ] && [ "$2" -le "$prev_bytes" ]
}

# Prints "N lines / M bytes" at 90% of the caps $1 and $2, leaving out a cap that is off.
headroom() {
    out=""
    [ "$1" -gt 0 ] && out="$(($1 * 9 / 10)) lines"
    [ "$2" -gt 0 ] && out="${out:+${out} / }$(($2 * 9 / 10)) bytes"
    printf '%s' "$out"
}

max_lines="$(limit "${AC_MEMORY_INDEX_MAX_LINES:-}" 80)"
max_bytes="$(limit "${AC_MEMORY_INDEX_MAX_BYTES:-}" 10240)"
max_line_bytes="$(limit "${AC_MEMORY_INDEX_MAX_LINE_BYTES:-}" 150)"
note_max_lines="$(limit "${AC_MEMORY_NOTE_MAX_LINES:-}" 40)"
note_max_bytes="$(limit "${AC_MEMORY_NOTE_MAX_BYTES:-}" 3072)"

# 0. Read the payload. jq is the only parser; without it, or without a payload, allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0

# 1. Only the auto-memory index and its topic notes matter; every other write, a repository's own
#    memory/MEMORY.md included, passes untouched. A note sits directly in the memory directory, so a
#    deeper path is not one.
case "$file" in
    */projects/*/memory/MEMORY.md) ;;
    */projects/*/memory/_index-*.md) exit 0 ;;
    */projects/*/memory/*.md)
        case "${file%/*}" in
            */projects/*/memory) ;;
            *) exit 0 ;;
        esac
        note=1
        ;;
    *) exit 0 ;;
esac
# The project directory is one segment under projects/, so a repository that happens to live under a
# projects/ directory (projects/app/docs/memory/guide.md) is not an auto-memory directory.
proj="${file%/memory/*}"
case "${proj##*/projects/}" in */*) exit 0 ;; esac
[ -f "$file" ] || exit 0

state=""
sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9_-')"
if [ -n "$sid" ]; then
    state="${TMPDIR:-/tmp}/ac-memory-budget-${sid}-$(printf '%s' "$file" | cksum | awk '{ print $1 }')"
fi

# 1b. A topic note: block only a write that grew it, so an already-long note can be trimmed or
#     repaired without being blocked on every touch. An Edit or MultiEdit that removed at least as
#     much as it added did not grow the file; a Write always counts.
if [ "${note:-}" = 1 ]; then
    grew="$(printf '%s' "$input" | jq -r '
        if .tool_name == "Edit" then ((.tool_input.new_string // "") | length) > ((.tool_input.old_string // "") | length)
        elif .tool_name == "MultiEdit" then ([.tool_input.edits[]? | (.new_string // "" | length) - (.old_string // "" | length)] | add // 0) > 0
        else true end' 2>/dev/null)" || grew=true

    lines="$(awk 'END { print NR }' "$file" 2>/dev/null)" || exit 0
    bytes="$(wc -c < "$file" | tr -d ' ')" || exit 0

    over=""
    [ "$note_max_lines" -gt 0 ] && [ "$lines" -gt "$note_max_lines" ] && over=1
    [ "$note_max_bytes" -gt 0 ] && [ "$bytes" -gt "$note_max_bytes" ] && over=1
    if [ -z "$over" ]; then
        [ -n "$state" ] && rm -f "$state" 2>/dev/null
        exit 0
    fi
    # Measured before this exit so a shrinking Edit that brings the note under budget still clears the state.
    [ "$grew" = "false" ] && exit 0
    no_larger "$lines" "$bytes" && exit 0
    [ -n "$state" ] && { printf '%s %s\n' "$lines" "$bytes" > "$state" 2>/dev/null; }

    reason="${file##*/} is over the memory note budget (${lines}/${note_max_lines} lines,"
    reason="${reason} ${bytes}/${note_max_bytes} bytes): ${file}."
    reason="${reason} Condense it now, before continuing. A memory note records one durable fact that a later"
    reason="${reason} session would get wrong without it: what was decided or found, why (the cause), and when"
    reason="${reason} it applies; cut it to that. Move a log, an audit, a runbook or reference material into a"
    reason="${reason} document in the repository and leave the note pointing at it. If an existing note already"
    reason="${reason} covers the topic, fold this one into it instead of adding another. The MEMORY.md line for"
    reason="${reason} the note stays one short hook. Never delete a note whose facts you have not carried over."
    target="$(headroom "$note_max_lines" "$note_max_bytes")"
    [ -n "$target" ] && reason="${reason} Condense to about 90% of the cap so the note has headroom: aim for at most ${target}."

    jq -n --arg reason "$reason" '{decision: "block", reason: $reason}' 2>/dev/null
    exit 0
fi

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
if [ -z "$over" ]; then
    [ -n "$state" ] && rm -f "$state" 2>/dev/null
    exit 0
fi
no_larger "$lines" "$bytes" && exit 0
[ -n "$state" ] && { printf '%s %s\n' "$lines" "$bytes" > "$state" 2>/dev/null; }

# 3. Over budget: say exactly what to fix and how, without deleting anything.
reason="MEMORY.md is over its budget (${lines}/${max_lines} lines, ${bytes}/${max_bytes} bytes"
[ -n "$long" ] && reason="${reason}; line numbers over ${max_line_bytes} bytes: ${long}"
reason="${reason}): ${file}."
reason="${reason} Consolidate it now, before continuing. Shorten each pointer to one hook of at most"
reason="${reason} ${max_line_bytes} bytes (non-ASCII letters count as two); merge pointers to duplicate or"
reason="${reason} superseded memories (fold the surviving facts into one topic file first); and when a theme"
reason="${reason} holds many entries, move them to a sub-index file named _index-<theme>.md in the same"
reason="${reason} directory, with frontmatter (name, description listing its keywords, metadata.type:"
reason="${reason} reference), leaving one line in MEMORY.md that names the theme and its keywords. New"
reason="${reason} memories on a theme that has a sub-index go into that sub-index. Never delete a topic file"
reason="${reason} whose facts you have not carried over."
target="$(headroom "$max_lines" "$max_bytes")"
[ -n "$target" ] && reason="${reason} Consolidate to about 90% of the cap so the index has headroom: aim for at most ${target}."

jq -n --arg reason "$reason" '{decision: "block", reason: $reason}' 2>/dev/null
exit 0
