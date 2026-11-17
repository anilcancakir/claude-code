#!/bin/sh
# SessionStart hook (compact only): hand the user's own requests of this session back to the model.
#
# A compaction summary paraphrases what the user asked, and a paraphrased request is the one that
# gets dropped. The transcript is append-only and keeps the records from before the compaction, so
# this hook reads them again and injects each typed request verbatim (whitespace collapsed, a paste
# reduced to its size, a long one cut to its head and tail), oldest first, newest kept when the list
# has to fit under 9,000 characters (Claude Code spills an additionalContext string above 10,000 to a
# file and shows a 2,000-character preview). The header calls the list history, so an old "push" or
# "deploy" is not read as an order to repeat.
#
# A request is a user record that is not meta, not the compaction summary, not a sidechain and not a
# tool result, whose turnOrigin is human or absent, or a queued_command attachment of human origin (a
# prompt typed while the model was working); its text must not be harness output, a `!` shell
# command, a slash command without arguments, or a command that only changes a setting. /compact is
# sometimes stored a second time as raw text, which the same command list skips.
#
# Silent on any other source, inside a subagent, with AC_USER_REQUESTS=0, without jq, and when the
# transcript yields no request. Fail open: exits 0 on every path.

set -u

[ "${AC_USER_REQUESTS:-}" = "0" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat 2>/dev/null)" || exit 0
field() {
    printf '%s' "$input" | jq -r --arg key "$1" '.[$key] // empty' 2>/dev/null
}

[ "$(field source)" = "compact" ] || exit 0
[ -z "$(field agent_id)" ] || exit 0
transcript="$(field transcript_path)"
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0

# Transcripts reach 400 MB. The fixed-string prefilter drops everything but user records and queued
# prompts, and the awk pass drops tool results, the bulk of them, except an AskUserQuestion answer
# (the only one carrying `"answers":{`); an unescaped `"type":"tool_result"` only occurs as
# structure, since the same text inside a prompt is stored escaped. jq then reads each line
# separately (fromjson?), so one corrupt line costs only itself.
program='
def prefixes: [
    "<task-notification>", "<local-command-stdout>", "<local-command-caveat>", "<system-reminder>",
    "<bash-stdout>", "<bash-stderr>", "<bash-input>", "This session is being continued from a previous conversation",
    "[Request interrupted by user"
];
def squash: gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "");
def stamp: if (.timestamp | type) == "string" and (.timestamp | length) >= 16
    then "[" + .timestamp[5:10] + " " + .timestamp[11:16] + "]" else "[--]" end;

def body:
    .message.content as $c
    | if ($c | type) == "string" then $c
      elif ($c | type) == "array" then
          if any($c[]; type == "object" and .type == "tool_result") then null
          else [$c[] | objects | select(.type == "text") | .text // ""] | join("\n") end
      else null end;

# Commands that only change a setting or the screen; their arguments are not a request.
def local_commands: [
    "/compact", "/model", "/effort", "/fast", "/output-style", "/config", "/permissions", "/theme", "/vim",
    "/status", "/cost", "/usage", "/memory", "/mcp", "/plugin", "/reload-plugins", "/reload-skills", "/login",
    "/logout", "/clear", "/exit", "/resume", "/rename", "/add-dir", "/hooks", "/agents", "/doctor", "/help",
    "/copy", "/autocompact"
];

# A paste is the user'"'"'s material, not their words; its size stays visible.
def unpaste: gsub("<pasted_content[^>]*>(?<b>[\\s\\S]*?)</pasted_content>"; "[pasted \(.b | length) chars]");

# {text, cmd, args} for one request, or empty. cmd and args are set for a slash command only.
def request($raw):
    ($raw | sub("^\\s+"; "")) as $t
    | if ($t | test("^<command-(message|name)>")) then
          (($t | capture("<command-name>(?<n>[^<]*)</command-name>")? // {n: ""}).n | squash) as $n
          | (if ($n | startswith("/")) then $n else "/" + $n end) as $name
          | (($t | capture("<command-args>(?<a>[\\s\\S]*?)</command-args>")? // {a: ""}).a | unpaste | squash) as $args
          | if $n == "" or $args == "" or any(local_commands[]; . == $name) then empty
            else {text: ($name + " " + $args), cmd: $name, args: $args} end
      elif ($t | test("^/[A-Za-z0-9:_.-]+(\\s|$)")) and any(local_commands[]; . as $c | $t | test("^" + $c + "(\\s|$)")) then empty
      elif ($t | test("^/[A-Za-z0-9:_.-]+\\s*$")) then empty
      elif any(prefixes[]; . as $p | $t | startswith($p)) then empty
      else {text: ($t | unpaste | squash)} end;

# A typed prompt is a user record; one typed while the model was working is a queued_command
# attachment whose origin is human, with no user record of its own.
def kept:
    select(type == "object")
    | . as $r
    | (if .type == "user" and (.toolUseResult | type) == "object" and (.toolUseResult.answers | type) == "object" then
           # An AskUserQuestion answer is a decision the user made; its notes are their own words.
           ((.toolUseResult.annotations // {}) as $notes
            | "(answered) " + ([.toolUseResult.answers | to_entries[]
                | (.key | squash | if length > 140 then .[:140] + " [...]" else . end) + " => " + (.value | tostring | squash)
                  + (($notes[.key].notes? // "") | if . == "" then "" else " (note: " + squash + ")" end)]
               | join("; ")))
       elif .type == "user" and .isMeta != true and .isCompactSummary != true and .isSidechain != true
            and ((.turnOrigin // "human") == "human") then body
       elif .type == "attachment" and .attachment.type? == "queued_command"
            and .attachment.origin.kind? == "human" then
           (.attachment.prompt as $p
            | if ($p | type) == "string" then $p
              elif ($p | type) == "array" then [$p[] | objects | select(.type == "text") | .text // ""] | join("\n")
              else null end)
       else null end) as $raw
    | select($raw != null)
    | request($raw)
    | select(.text != "")
    | . + {stamp: ($r | stamp)};

# A long request keeps its head and its tail, where a question after a paste usually sits.
def cut: if length > 600 then .[:400] + " [...] " + .[-180:] else . end;

([inputs | fromjson? | kept]
    | reduce .[] as $r ([];
        if length > 0 and .[-1].text == $r.text then .
        # One typed message holding several commands: one entry naming all of them.
        elif length > 0 and $r.cmd != null and .[-1].cmd != null and .[-1].stamp == $r.stamp
             and .[-1].args == $r.args then
            .[-1] |= (.cmd += " " + $r.cmd | .text = .cmd + " " + .args)
        else . + [$r] end)
    | map(. + {shown: (.text | cut), cut: ((.text | length) > 600)})) as $all
| "ac: the user'"'"'s requests in this session, verbatim, oldest first. A compaction summary paraphrases them. This is history, not a to-do list: a later request overrides an earlier one, and an old push, merge, deploy or approval authorises nothing now. Before you report done, check that what the latest requests asked for, and what the summary marks pending, is done." as $head
| ("(99999 older requests dropped; full text: " + $path + ")") as $footReserve
| (9000 - ($head | length) - ($footReserve | length) - 4) as $budget
| ($all | reverse | reduce .[] as $r ({kept: [], used: 0, full: false};
        if .full then .
        else (($r.stamp | length) + ($r.shown | length) + 8) as $n
            | if .used + $n > $budget then .full = true else .kept += [$r] | .used += $n end
        end) | .kept | reverse) as $kept
| select(($kept | length) > 0)
| (($all | length) - ($kept | length)) as $dropped
| ($kept | to_entries | map("\(.key + 1). \(.value.stamp) \(.value.shown)") | join("\n")) as $list
| (any($kept[]; .cut)) as $anyCut
| ($head + "\n\n" + $list
    + (if $dropped > 0 then "\n(\($dropped) older requests dropped; full text: \($path))"
       elif $anyCut then "\n(long requests cut at [...]; full text: \($path))"
       else "" end)) as $context
| {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $context}}
'

grep -aF -e '"type":"user"' -e '"queued_command"' "$transcript" 2>/dev/null \
    | awk 'index($0, "\"type\":\"tool_result\"") == 0 || index($0, "\"answers\":{") > 0' 2>/dev/null \
    | jq -cnR --arg path "$transcript" "$program" 2>/dev/null
exit 0
