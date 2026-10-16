#!/bin/sh
# UserPromptSubmit hook that keeps a session's title current, opt-in through AC_SESSION_TITLE=1.
#
# Claude Code titles an interactive session once, from its first real prompt, as an `ai-title`
# record, and never again: of 190 sessions carrying one on 2026-10-17, every one held a single value,
# and a resumed session is never retitled. A long session therefore keeps the name of whatever it
# opened with. A UserPromptSubmit hook may return `hookSpecificOutput.sessionTitle`, which the
# binary applies like /rename (a `custom-title` record, source "hook"; read off 2.1.302), so this hook:
#   1. counts the prompts the user typed (`source` "user", or no `source` on an older payload);
#   2. on the first prompt and every AC_SESSION_TITLE_EVERY-th one (default 10), runs a detached
#      copy of itself (--generate) that asks an isolated `claude -p` on Haiku for a 2 to 4 word
#      kebab-case name (lib/session-title.md) and leaves it in a pending file;
#   3. on the next prompt returns the pending name as sessionTitle, so no prompt waits on a model.
#
# A name the user gives wins for good. The binary records a hook title and a /rename the same way,
# so the hook remembers every title it set; a last `custom-title` in the transcript that is none of
# them (or one of them plus the `-word-word` suffix the binary adds when another live session holds
# the name) is the user's, and the hook stops touching that session. A state file lost to a cleared
# TMPDIR makes the hook's own earlier title read as the user's, which also stops it: the safe side.
#
# Environment:
#   AC_SESSION_TITLE        1 turns the hook on; anything else leaves it silent
#   AC_SESSION_TITLE_EVERY  prompts between generations after the first (default 10)
#   AC_SESSION_TITLE_MODEL  the generator's model (default haiku)
#   AC_SESSION_TITLE_PROMPT a naming prompt file of your own; without it, a readable
#                           ${CLAUDE_CONFIG_DIR:-~/.claude}/ac/session-title.md is used, then the
#                           built-in lib/session-title.md. {{CURRENT}} and {{CONVERSATION}} are filled in,
#                           and the model must answer {"title": "..."}.
#   AC_SESSION_TITLE_PATTERN the jq regex a title must match (default: 2 to 4 kebab-case words for the
#                           built-in prompt, any single line for a prompt of your own)
#   AC_SESSION_TITLE_CHILD  set inside the generator's own session, which is skipped
#
# State lives under TMPDIR, keyed by session id: ac-session-title-<sid> (the count or `stopped`, the
# transcript offset scanned, the last custom title seen, then the titles this hook set), .pending (a
# generated name not yet applied) and .lock (a generator in flight). A prompt that neither applies a
# name nor starts a generation reads only the state file.

set -u

# The naming prompt: AC_SESSION_TITLE_PROMPT names a file, else the user's own copy under the config
# dir, else the built-in kebab-case one. A missing file falls through to the next source, so a typo
# in the path names sessions the default way rather than not at all.
naming_prompt() {
    for _p in "${AC_SESSION_TITLE_PROMPT:-}" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ac/session-title.md"; do
        [ -n "$_p" ] && [ -f "$_p" ] && [ -r "$_p" ] && { printf '%s' "$_p"; return 0; }
    done
    printf '%s' "$(dirname "$0")/lib/session-title.md"
}
prompt_file="$(naming_prompt)"

# What a generated title must match: AC_SESSION_TITLE_PATTERN when set; the built-in prompt's 2 to
# 4 kebab-case words otherwise; any title for a prompt the user wrote, whose format this hook cannot
# know. The pattern is a jq (Oniguruma) regex, and one that does not compile rejects every title.
if [ -n "${AC_SESSION_TITLE_PATTERN:-}" ]; then
    title_pattern="$AC_SESSION_TITLE_PATTERN"
elif [ "$prompt_file" = "$(dirname "$0")/lib/session-title.md" ]; then
    title_pattern='^[a-z0-9]+(-[a-z0-9]+){1,3}$'
else
    title_pattern='.'
fi

# Prints the title, trimmed the way the binary trims a name, when it is one line of 1 to 80
# characters with no control character and matches the pattern. The control-character guard holds
# whatever the pattern says, so an unanchored custom pattern cannot let an escape sequence through.
valid_title() {
    printf '%s' "$1" | jq -Rrse --arg p "$title_pattern" '
        gsub("^\\s+|\\s+$"; "")
        | select(length > 0 and length <= 80 and test("^[^\\x00-\\x1f\\x7f]+$") and test($p))' 2>/dev/null
}

# Succeeds when the title is one this hook set, or one of them plus the suffix the binary adds when
# another live session holds the name (its own pattern, `-([a-z]+-[a-z]+)(-\d{1,4})?$`).
owned_title() {
    printf '%s' "$owned" | jq -Rrse --arg c "$1" '
        split("\n") | map(select(length > 0))
        | any(. as $own | $c == $own
              or ($c | startswith($own + "-") and (ltrimstr($own) | test("^-[a-z]+-[a-z]+(-[0-9]{1,4})?$"))))' \
        >/dev/null 2>&1
}

# The conversation excerpt for the generator, built from the active context: the latest compaction
# summary when the session has one (else the first user prompt), then the last 50 entries after it,
# then the prompt that triggered the run. An entry is a user prompt (cut to 400 characters), an
# assistant text (300), or one line per tool call that does something (an edit, a command, a skill,
# an agent, a fetch), so the name follows what was done and not only what was said; read-only lookups
# are left out as noise. The hook fires before its prompt reaches the transcript (measured live on
# 2.1.302: the first prompt's run found no user turn at all), so that prompt is passed in.
# Tool results, hook feedback, reminders and other injected turns are skipped; a slash command counts
# as its name and arguments. A large transcript is read as its head, its latest summary line and its
# tail only, since a jsonl line can hold a whole request body.
conversation_excerpt() {
    summary_mark='This session is being continued from a previous conversation'
    lines="$(wc -l < "$1" 2>/dev/null | tr -d ' ')"
    case "$lines" in '' | *[!0-9]*) lines=0 ;; esac
    if [ "$lines" -gt 4500 ]; then
        { head -n 1500 "$1"; grep -F "$summary_mark" "$1" | tail -n 1; tail -n 3000 "$1"; } 2>/dev/null
    elif [ -f "$1" ]; then
        cat "$1" 2>/dev/null
    fi | jq -Rrn --arg now "$2" --arg mark "$summary_mark" '
        def squash($n): gsub("\\s+"; " ") | .[:$n];
        def tool_line:
            (.input.file_path // .input.command // .input.description // .input.skill // .input.url
             // .input.query // .input.prompt // "") as $d
            | "\(.name) \($d | tostring | squash(160))";
        [inputs | fromjson? | select(.type == "user" or .type == "assistant")
         | select((.isMeta // false) == false and .toolUseResult == null)
         | if .type == "assistant" then
               .message.content | if type == "array" then .[] else empty end
               | if .type == "text" and (.text | length) > 0 then {role: "Assistant", text: (.text | squash(300))}
                 elif .type == "tool_use" and (.name | test("^(Read|Grep|Glob|LSP|ToolSearch|TaskOutput|TodoWrite)$") | not)
                 then {role: "Tool", text: tool_line}
                 else empty end
           else
               (.message.content
                | if type == "array" then map(select(.type == "text") | .text) | join("\n")
                  elif type == "string" then . else "" end) as $raw
               | if $raw | startswith($mark) then {role: "Summary", text: ($raw | squash(2500))}
                 elif $raw | test("^\\s*<command-(message|name)>") then
                     ([$raw | capture("<command-name>(?<n>[^<]*)</command-name>").n] | first // "") as $name
                     | ([$raw | capture("<command-args>(?<a>[\\s\\S]*?)</command-args>").a] | first // "") as $args
                     | if ($args | length) > 0 then {role: "User", text: ("\($name) \($args)" | squash(400))} else empty end
                 elif $raw | test("^\\s*(<task-notification|<system-reminder|Stop hook feedback|<local-command|<bash-|\\[Request interrupted|<cross-session)") then empty
                 elif ($raw | length) > 0 then {role: "User", text: ($raw | squash(400))}
                 else empty end
           end]
        | ([to_entries[] | select(.value.role == "Summary") | .key] | last) as $cut
        | (if $cut == null then . else .[$cut + 1:] end | map(select(.role != "Summary"))) as $active
        | $active[-50:] as $tail
        | (map(select(.role == "User")) | first) as $first
        | ($now | squash(400)) as $prompt
        | (if $cut != null then [.[$cut], {role: "", text: "[...]"}]
           elif $first != null and ($tail | index([$first])) == null then [$first, {role: "", text: "[...]"}]
           else [] end)
          + $tail
          + (if ($prompt | length) > 0 and ($tail | map(select(.role == "User")) | last) != {role: "User", text: $prompt}
             then [{role: "User", text: $prompt}] else [] end)
        | map(if .role == "" then .text elif .role == "Summary" then "Earlier in this session (summary): \(.text)"
              else "\(.role): \(.text)" end)
        | join("\n")' 2>/dev/null
}

# The detached generator: one isolated `claude -p` under a perl alarm (macOS ships no `timeout`),
# with no settings, plugins, MCP servers, tools or saved session, so none of these hooks fire inside
# it. Anything short of a valid new name writes nothing. Its inputs arrive in the environment rather
# than argv, so the prompt text does not show in another user's `ps`.
generate() {
    sid="${AC_SESSION_TITLE_GEN_SID:-}"
    transcript_path="${AC_SESSION_TITLE_GEN_TRANSCRIPT:-}"
    current="${AC_SESSION_TITLE_GEN_CURRENT:-}"
    prompt_now="${AC_SESSION_TITLE_GEN_PROMPT:-}"
    case "$sid" in '' | *[!A-Za-z0-9-]*) return 0 ;; esac
    state="${TMPDIR:-/tmp}/ac-session-title-$sid"
    pending="$state.pending"
    lock="$state.lock"
    mkdir "$lock" 2>/dev/null || return 0
    trap 'rmdir "$lock" 2>/dev/null' EXIT

    command -v claude >/dev/null 2>&1 || return 0
    command -v perl >/dev/null 2>&1 || return 0
    template="$prompt_file"
    [ -f "$template" ] || return 0
    excerpt="$(conversation_excerpt "$transcript_path" "$prompt_now")"
    [ -n "$excerpt" ] || return 0

    prompt="$(jq -rn --rawfile t "$template" --arg c "${current:-(none)}" --arg x "$excerpt" '
        $t | split("{{CURRENT}}") | map(split("{{CONVERSATION}}") | join($x)) | join($c)' 2>/dev/null)" \
        || return 0
    reply="$(cd "${TMPDIR:-/tmp}" && printf '%s' "$prompt" | AC_SESSION_TITLE_CHILD=1 perl -e 'alarm shift; exec @ARGV; exit 127' \
        45 claude -p --model "${AC_SESSION_TITLE_MODEL:-haiku}" --no-session-persistence --setting-sources '' \
        --strict-mcp-config --disable-slash-commands --tools '' --output-format json \
        --json-schema '{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}' 2>/dev/null)" \
        || return 0
    title="$(printf '%s' "$reply" | jq -r '
        (if type == "array" then map(select(.type == "result")) | last else . end)
        | .structured_output.title // empty' 2>/dev/null)"
    title="$(valid_title "$title")" || return 0
    [ "$title" != "$current" ] || return 0

    [ -L "$pending" ] && return 0
    printf '%s\n' "$title" > "$pending.$$" 2>/dev/null && mv -f "$pending.$$" "$pending" 2>/dev/null
    return 0
}

if [ "${1:-}" = "--generate" ]; then
    command -v jq >/dev/null 2>&1 && generate
    exit 0
fi

# 0. Opt-in, and never inside the generator's own session or a headless run.
[ "${AC_SESSION_TITLE:-}" = "1" ] || exit 0
[ -z "${AC_SESSION_TITLE_CHILD:-}" ] || exit 0
case "${CLAUDE_CODE_ENTRYPOINT:-}" in sdk-*) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0
input="$(cat 2>/dev/null)" || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Only a prompt the user typed counts; a wakeup, a task notification or a peer message does not.
source="$(printf '%s' "$input" | jq -r '.source // "user"' 2>/dev/null)"
[ "$source" = "user" ] || exit 0
sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
case "$sid" in '' | *[!A-Za-z0-9-]*) exit 0 ;; esac
transcript_path="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"
session_title="$(printf '%s' "$input" | jq -r '.session_title // empty' 2>/dev/null)"
every="${AC_SESSION_TITLE_EVERY:-10}"
case "$every" in '' | *[!0-9]* | 0) every=10 ;; esac

state="${TMPDIR:-/tmp}/ac-session-title-$sid"
pending="$state.pending"
lock="$state.lock"
[ -L "$state" ] || [ -L "$pending" ] && exit 0

# 2. State: the prompt count (or `stopped` once the user named the session), the transcript offset
#    scanned so far, the last custom title seen there, then the titles this hook set.
count=0
offset=0
seen=""
owned=""
if [ -f "$state" ]; then
    count="$(sed -n 1p "$state" 2>/dev/null)"
    offset="$(sed -n 2p "$state" 2>/dev/null)"
    seen="$(sed -n 3p "$state" 2>/dev/null)"
    owned="$(tail -n +4 "$state" 2>/dev/null)"
fi
[ "$count" = "stopped" ] && exit 0
case "$count" in '' | *[!0-9]*) count=0 ;; esac
case "$offset" in '' | *[!0-9]*) offset=0 ;; esac

save_state() {
    { printf '%s\n%s\n%s\n' "$1" "$offset" "$seen"; printf '%s\n' "$owned" | sed '/^$/d' | tail -n 20; } \
        > "$state" 2>/dev/null
}

count=$((count + 1))
due=""
{ [ "$count" -eq 1 ] || [ $((count % every)) -eq 0 ]; } && due=1

# 3. Who names this session is only asked when the answer is about to matter: a name is waiting to
#    be applied or a generation is due. The transcript is scanned from where the last scan stopped,
#    because a long session's file runs to hundreds of megabytes (a full grep of one 495 MB file took
#    3.6 s); the binary re-appends metadata, so the last custom title in the new bytes is the current
#    one, and a file shorter than the offset was rewritten and is scanned again from the start.
if [ -n "$due" ] || [ -f "$pending" ]; then
    if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
        size="$(wc -c < "$transcript_path" 2>/dev/null | tr -d ' ')"
        case "$size" in '' | *[!0-9]*) size=0 ;; esac
        if [ "$size" -lt "$offset" ]; then
            offset=0
            seen=""
        fi
        # A first scan of a large file reads its last 2 MB: a resume re-appends the session metadata
        # at the tail, and a new session's file is small.
        if [ "$offset" -eq 0 ] && [ "$size" -gt 2097152 ]; then
            offset=$((size - 2097152))
        fi
        latest="$(tail -c "+$((offset + 1))" "$transcript_path" 2>/dev/null | grep -F '"type":"custom-title"' \
            | tail -n 1 | jq -r '.customTitle // empty' 2>/dev/null)"
        [ -n "$latest" ] && seen="$latest"
        offset="$size"
    fi

    # A custom title this hook did not set is the user's: stop for good, and say so in the state so
    # every later prompt exits before reading anything.
    if [ -n "$seen" ] && ! owned_title "$seen"; then
        rm -f "$pending" 2>/dev/null
        save_state stopped
        exit 0
    fi
fi

# 4. Apply a name the generator left since the last prompt. A pending file another user could have
#    planted under a shared /tmp is not ours to apply.
apply=""
if [ -f "$pending" ]; then
    candidate=""
    [ -O "$pending" ] && candidate="$(valid_title "$(head -n 1 "$pending" 2>/dev/null)")"
    rm -f "$pending" 2>/dev/null
    if [ -n "$candidate" ] && [ "$candidate" != "$seen" ]; then
        apply="$candidate"
        owned="$(printf '%s\n%s\n' "$owned" "$apply")"
    fi
fi
save_state "$count" || exit 0

# 5. On the first prompt and every Nth, start a generator unless one is in flight. A lock older than
#    two minutes outlived the generator's 45 s alarm, so it is stale.
if [ -n "$due" ]; then
    if [ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
        rmdir "$lock" 2>/dev/null
    fi
    if [ ! -d "$lock" ]; then
        AC_SESSION_TITLE_GEN_SID="$sid" \
            AC_SESSION_TITLE_GEN_TRANSCRIPT="$transcript_path" \
            AC_SESSION_TITLE_GEN_CURRENT="${apply:-${session_title:-$seen}}" \
            AC_SESSION_TITLE_GEN_PROMPT="$(printf '%s' "$input" | jq -r '.prompt // "" | .[:2000]' 2>/dev/null)" \
            nohup sh "$0" --generate </dev/null >/dev/null 2>&1 &
    fi
fi

[ -n "$apply" ] || exit 0
jq -cn --arg t "$apply" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: $t}}'
exit 0
