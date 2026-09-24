#!/bin/sh
# Stop guard for premature turn endings, active in every main-thread session.
#
# Blocks a turn that ends on an announced-but-not-taken next step, an offer to continue, or a
# question asked in prose, and tells the model the legitimate ways to end instead. Every other
# condition fails OPEN (exit 0, no output).
#
# Why it exists: an audit of every "devam et" / "durma" nudge since 2026-08-01 found about 190
# needless stops against 6 real blockers. The largest classes were exactly these shapes
# (64 announce-and-stop, 37 offer-to-continue, 14 prose questions), and most of them happened
# outside /ac:execute and /ac:auto, where the marker-based guards never arm. Anthropic's Opus 5.5
# prompting guide documents the same shape: a progress report that ends the turn with text and
# no tool call. Milestone stops and decision lists read like finished reports, so they stay with
# the prompt side (the "Run to completion" section of the global CLAUDE.md).
#
# It reads `last_assistant_message` from the Stop payload (https://code.claude.com/docs/en/hooks.md,
# Stop input) and only its last paragraph, with fenced code and inline code removed, so a long
# report that mentions "next" in its body, or SQL with a `?`, is not caught. Background work or a
# cron that will wake the session means the guard allows the stop (lib/wake-count.jq, loose mode).
#
# Two stages. The regexes below are the recall stage: they catch almost every ending shaped like
# an announcement, an offer or a question, and on their own they were wrong more often than
# right. Over the first day live they blocked 18 stops and about 10 of them were handoffs: "order
# the parts, build it, tell me the result", "run /ac:install yourself", a peer session's next
# step, "bekliyorum" meaning "I expect". Turkish imperatives addressed to the user ("kur", "söyle")
# and the assistant's own step read alike to a regex. So a regex hit goes to a judge: an isolated
# `claude -p` on Sonnet reads the ending with the user's last request (lib/announce-judge.md) and
# only a parsed `"ok": false` blocks. On 44 unseen regex-positive stops that cut wrong blocks from
# 24 to 5 and missed 3 of 20; Haiku flipped 8 of 107 decisions between identical runs and repeated
# the regex's handoff mistakes, so the model is not Haiku. A missing `claude` or `perl`, a
# timeout, an error or an unparsable verdict allows the stop.
#
# Why not a `type: "prompt"` Stop hook: on 2.1.281 its evaluator receives the whole conversation
# (trimmed only above half the model's context window), under a system prompt that returns
# `ok: false` on "insufficient evidence", on every stop of every session, `claude -p` runs
# included. This hook pays for a judge only on the few stops the regexes and the gates let through.
#
# A block is sent as `additionalContext`, which continues the turn through the same loop
# protections as `decision: "block"` but is labelled hook feedback rather than a hook error.
#
# Loop bound: `stop_hook_active` stays true across tool turns within one prompt, so it cannot
# count "blocks since real work" on its own. The counter therefore stores the transcript size at
# its last block and resets when tool activity appeared after it, the same progress signal
# stop-guard.sh uses. So at most AC_ANNOUNCE_GUARD_MAX_BLOCKS (default 1) blocks per stall and
# AC_ANNOUNCE_GUARD_MAX_TOTAL (default 3) per prompt; the total resets only when a stop arrives
# with `stop_hook_active` false. Claude Code's own 8-block cap resets on every tool round, so it
# is no backstop here. Headless and SDK runs are skipped, and so is the judge's own session
# (AC_ANNOUNCE_JUDGE). The counter lives under TMPDIR, keyed by session id, so the guard writes
# nothing into projects that do not use ac.

set -u

max_blocks="${AC_ANNOUNCE_GUARD_MAX_BLOCKS:-1}"
case "$max_blocks" in
    '' | *[!0-9]*) max_blocks=1 ;;
esac
[ "$max_blocks" -gt 0 ] || exit 0
max_total="${AC_ANNOUNCE_GUARD_MAX_TOTAL:-3}"
case "$max_total" in
    '' | *[!0-9]*) max_total=3 ;;
esac
judge_model="${AC_ANNOUNCE_JUDGE_MODEL:-sonnet}"
judge_timeout="${AC_ANNOUNCE_JUDGE_TIMEOUT:-20}"
case "$judge_timeout" in
    '' | *[!0-9]*) judge_timeout=20 ;;
esac

# Headless and SDK runs (claude -p) have a caller reading the printed result; a forced
# continuation there changes the output rather than finishing a task someone walked away from.
# The judge's own session is one of them, and the variable makes that explicit.
[ -z "${AC_ANNOUNCE_JUDGE:-}" ] || exit 0
case "${CLAUDE_CODE_ENTRYPOINT:-}" in sdk-*) exit 0 ;; esac

input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# A subagent's stop is not ours to judge. `agent_id` marks one; `agent_type` alone also appears on
# a main session started with --agent, which this guard should still cover.
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)"
[ -z "$agent_id" ] || exit 0

session_id="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$session_id" ] || exit 0
case "$session_id" in *[!A-Za-z0-9-]*) exit 0 ;; esac

counter="${TMPDIR:-/tmp}/ac-announce-guard-$session_id"
[ -L "$counter" ] && exit 0
stop_hook_active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)"
[ "$stop_hook_active" = "true" ] || rm -f "$counter" 2>/dev/null

# Something already armed will wake the session; ending the turn is correct. A long-lived shell
# (a dev server, a mock) is not counted: it never finishes, so it wakes nothing, and counting it
# switched this guard off for as long as one ran. lib/wake-count.jq decides; a jq failure allows.
wake_count="$(printf '%s' "$input" | jq -r --arg mode loose -f "$(dirname "$0")/lib/wake-count.jq" 2>/dev/null)" || exit 0
case "$wake_count" in '' | *[!0-9]*) exit 0 ;; esac
[ "$wake_count" -eq 0 ] || exit 0

# An armed /ac:execute or /ac:auto marker owned by this session already has its own guard with
# a richer reason; do not stack a second block on the same stop.
payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
for _dir in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$_dir" ] || continue
    for _m in "$_dir/.ac/state/active-execution.json" "$_dir/.ac/state/active-auto.json"; do
        [ -f "$_m" ] || continue
        [ "$(jq -r '.session_id // empty' "$_m" 2>/dev/null)" = "$session_id" ] && exit 0
    done
done

msg="$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)"
[ -n "$msg" ] || exit 0

if ! command -v rg >/dev/null 2>&1; then
    printf '%s\n' "ac stop-guard-announce: ripgrep (rg) not found; guard inactive." >&2
    exit 0
fi

# Last non-empty paragraph with fenced blocks dropped, inline code and double-quoted spans removed
# (a quoted trigger word is a mention, not an offer), the dotted capital I folded (rg -i does not
# fold it), emphasis stripped; the last line is kept for the "?" test. Single quotes stay: Turkish
# uses them as the suffix apostrophe.
fences="$(printf '%s\n' "$msg" | awk '/^[[:space:]]*(```|~~~)/{n++} END{print n+0}')"
fence_filter='/^[[:space:]]*(```|~~~)/{f=!f; next} !f'
[ $((fences % 2)) -eq 0 ] || fence_filter='{print}'
para="$(printf '%s\n' "$msg" | awk "$fence_filter" | awk 'BEGIN{RS=""} {p=$0} END{print p}')"
# An odd number of straight quotes (a 12" screen) would shift every pair after it and swallow real
# text, so straight-quote spans are only stripped when the quotes balance.
quotes="$(printf '%s' "$para" | tr -cd '"' | wc -c | tr -d ' ')"
quote_filter='s/"[^"]*"//g'
[ $((quotes % 2)) -eq 0 ] || quote_filter='s/^//'
tail_par="$(printf '%s\n' "$para" \
    | sed -e 's/İ/i/g' -e 's/`[^`]*`//g' -e "$quote_filter" -e 's/“[^”]*”//g' -e 's/[*_]//g' -e 's/[[:space:]]*$//' \
    | tail -c 600)"
[ -n "$tail_par" ] || exit 0
last_line="$(printf '%s\n' "$tail_par" | awk 'NF{l=$0} END{print l}')"

match() { printf '%s' "$1" | rg --no-config -q -i "$2"; }

# A named blocker the user must clear is a legitimate end, even when phrased like a wait.
if match "$tail_par" '(s[ıi]ra(da|daki)\b.{0,40}\b(yok|kalmad[ıi])\b|\b(token|anahtar|api key|key|parola|[şs]ifre|secret|credential|password|oauth|team_id|app id|parmak izi|2fa|otp|do[ğg]rulama kodu)\w*.{0,60}\b(ver|gir|yap[ıi][şs]t[ıi]r|d[öo]nd[üu]r|koy|olmadan|laz[ıi]m|gerek\w*|sende|bekliyorum|required|needed)\b|\b(sudo|login|giri[şs] yap)\b.{0,40}\b(sende|senin|yapman|laz[ıi]m)|\w+(d[ıi]ğ[ıi]nda|d[iu]ğ[iu]nda|d[üu]ğ[üu]nde|[iü]nce|[ıu]nca)\s+(bana\s+)?(s[öo]yle|yaz|haber ver)\b|\b(fiziksel|[öo]l[çc][üu]m[üu]n[üu]?|cihaz[ıi]n[ıi]?|kart[ıi]) .{0,40}(yap|tak|ba[ğg]la|[öo]l[çc])|nothing (left|remaining))'; then
    exit 0
fi

kind=""
if match "$tail_par" '(devam edeyim mi|devam ederim|devam edelim|ister misin|ister misiniz|istersen|isterseniz|onaylarsan|tercih ediyorsan|ne dersen|haz[ıi]r oldu[ğg]unda|yapay[ıi]m m[ıi]|edeyim mi|ba[şs]layay[ıi]m m[ıi]|\w{2,}(ay[ıi]m|eyim)\b[^:]|\w{2,}(ay[ıi]m|eyim)$|(senin|sizin) (istemen|onay[ıi]n|karar[ıi]n)|onay[ıi]n[ıi] bekliyorum|want me to|shall i\b|should i (continue|proceed|go ahead)|would you like me to|if you(.d| would) like me to|if you want me to|let me know if you|\b(m[ıiuü]|m[ıiuü]s[ıi]n|m[ıiuü]s[ıi]n[ıi]z)\?)'; then
    kind="offer"
elif match "$tail_par" '(devam ediyorum|devam edece[ğg]im|s[ıi]rada\b|s[ıi]radaki (ad[ıi]m|i[şs]|tur|commit|plan)|sonraki (ad[ıi]m|tur|i[şs])|a[çc][ıi]l[ıi]yor\b|izliyorum|takip ediyorum|(d[öo]n[üu]yorum|ge[çc]iyoruz|ba[şs]l[ıi]yoruz)|ge[çc]iyorum|ba[şs]l[ıi]yorum|[şs]imdi\b.{0,80}[ıiuü]yorum\b|(bitince|tamamlan[ıi]nca|gelince|olunca|d[öo]n[üu]nce|d[üu][şs][üu]nce)\b.{0,80}(r[ıiuü]m|ece[ğg]im|aca[ğg][ıi]m|ecek|acak)\b|bekliyorum|next,? i(.ll| will)\b|i.ll now\b|moving on to|proceeding (to|with)\b|^let me\b|i.m waiting|waiting (for|on) )' \
    || match "$tail_par" '(ece[ğg]im|aca[ğg][ıi]m)[;:,]' \
    || { match "$last_line" '(ece[ğg]im|aca[ğg][ıi]m)[.!]?\s*$' \
         && ! match "$last_line" '(mayaca[ğg][ıi]m|meyece[ğg]im)[.!]?\s*$'; } \
    || { match "$last_line" '[ıiuü]yorum[.!]?\s*$' \
         && ! match "$last_line" '(öner|d[üu][şs][üu]n|g[öo]r|bil|anl|um|san|zannet|tahmin ed|m)[ıiuü]yorum[.!]?\s*$'; }; then
    kind="announce"
elif match "$last_line" '\?\s*$'; then
    kind="question"
fi
[ -n "$kind" ] || exit 0

# Reset the count when tool activity appeared since the last block: a new stall gets a fresh budget.
transcript_path="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"
tsize=0
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
    tsize="$(wc -c < "$transcript_path" 2>/dev/null | tr -d ' ')"
fi
case "$tsize" in '' | *[!0-9]*) tsize=0 ;; esac

blocks=0
total=0
if [ -f "$counter" ]; then
    read -r prev_blocks prev_tpos total < "$counter" 2>/dev/null || prev_blocks=0
    case "${prev_blocks:-}" in '' | *[!0-9]*) prev_blocks=0 ;; esac
    case "${prev_tpos:-}" in '' | *[!0-9]*) prev_tpos=0 ;; esac
    case "${total:-}" in '' | *[!0-9]*) total=0 ;; esac
    blocks="$prev_blocks"
    if [ "$prev_tpos" -gt 0 ] && [ "$tsize" -gt "$prev_tpos" ] \
        && tail -c "+$prev_tpos" "$transcript_path" 2>/dev/null | grep -q '"type":"tool_use"'; then
        blocks=0
    fi
fi
[ "$blocks" -lt "$max_blocks" ] || exit 0
[ "$total" -lt "$max_total" ] || exit 0

# The user's last real prompt from the transcript tail, so the judge can tell work the request
# covers from extra work. A slash command counts as its name plus arguments (an argless one such as
# /compact is skipped). Tool results, task-notifications, hook feedback, `!` shell input and
# injected reminders are skipped; anything unreadable gives an empty string and the judge is told.
last_request() {
    [ -n "$transcript_path" ] && [ -f "$transcript_path" ] || return 0
    tail -n 2000 "$transcript_path" 2>/dev/null | jq -Rrn '
        [inputs | fromjson? | select(.type == "user" and (.isMeta // false) == false and .toolUseResult == null)
         | .message.content
         | if type == "array" then map(select(.type == "text") | .text) | join("\n")
           elif type == "string" then . else empty end
         | select(length > 0)
         | if test("^\\s*<command-(message|name)>") then
               ([capture("<command-name>(?<n>[^<]*)</command-name>").n] | first // "") as $name
               | ([capture("<command-args>(?<a>[\\s\\S]*?)</command-args>").a] | first // "") as $args
               | if ($args | length) > 0 then "\($name) \($args)" else empty end
           elif test("^\\s*(<task-notification|<system-reminder|Stop hook feedback|<local-command|<bash-|\\[Request interrupted|<cross-session|This session is being continued)") then empty
           else . end]
        | last // empty' 2>/dev/null
}

# Returns 0 only when the judge answers with a parsed `"ok": false`. It runs from TMPDIR with no
# settings, plugins, MCP servers, tools or saved session, under a perl alarm (macOS ships no
# `timeout`), so the hook's own 25 s registration timeout is never the bound that fires.
judge_blocks() {
    # A session pointed at another endpoint (ANTHROPIC_BASE_URL) would resolve `sonnet` to that
    # provider's model, a judge nobody measured, so it skips the judge and the stop is allowed.
    [ -z "${ANTHROPIC_BASE_URL:-}" ] || return 1
    command -v claude >/dev/null 2>&1 || return 1
    command -v perl >/dev/null 2>&1 || return 1
    template="$(dirname "$0")/lib/announce-judge.md"
    [ -f "$template" ] || return 1
    prompt="$(jq -rn --rawfile t "$template" --arg r "$(last_request)" --arg m "$msg" '
        ($r | if length == 0 then "(not available)"
              elif length > 1500 then .[:750] + "\n[...]\n" + .[-750:] else . end) as $req
        | $t | split("{{REQUEST}}") | map(split("{{MESSAGE}}") | join($m[-4000:])) | join($req)' 2>/dev/null)" \
        || return 1
    verdict="$(cd "${TMPDIR:-/tmp}" && printf '%s' "$prompt" | AC_ANNOUNCE_JUDGE=1 perl -e 'alarm shift; exec @ARGV; exit 127' \
        "$judge_timeout" claude -p --model "$judge_model" --no-session-persistence --setting-sources '' \
        --strict-mcp-config --disable-slash-commands --tools '' --output-format json \
        --json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}' 2>/dev/null)" \
        || return 1
    printf '%s' "$verdict" | jq -e '
        (if type == "array" then map(select(.type == "result")) | last else . end)
        | .structured_output.ok == false' >/dev/null 2>&1
}
judge_blocks || exit 0

blocks=$((blocks + 1))
total=$((total + 1))
printf '%s %s %s\n' "$blocks" "$tsize" "$total" > "$counter" 2>/dev/null || exit 0

case "$kind" in
    offer) found="Your last message offers to continue instead of continuing." ;;
    announce) found="Your last message announces a next step, or says you are waiting, without a tool call that does it." ;;
    question) found="Your last message ends on a question asked in prose, which ends the turn and stalls the work until the user returns." ;;
esac

reason="$found

- If that step is yours and the user's request covers it, take it now with its tool call.
- If the user has to decide, including an outward action (push, merge, deploy, publish) the request did not name, finish what does not depend on it and call AskUserQuestion with your recommendation first.
- If you are waiting on CI, a deploy or a bot, nothing that will notify you is running: arm Monitor, or Bash with run_in_background under \`timeout N\`, then end the turn. Never wait with a sleep or polling loop.
- If the next step belongs to the user or someone else, end with one line that says so. Do not repeat your report."

jq -cn \
    --arg r "$reason" \
    --arg m "ac stop-guard-announce: continued the turn ($kind, $blocks/$max_blocks)" \
    '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: $r}, systemMessage: $m}'
exit 0
