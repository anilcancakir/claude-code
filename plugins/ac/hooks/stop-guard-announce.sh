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
# report that mentions "next" in its body, or SQL with a `?`, is not caught. `background_tasks` or
# `session_crons` non-empty means something will wake the session, so the guard allows the stop.
#
# Loop bound: `stop_hook_active` stays true across tool turns within one prompt, so it cannot
# count "blocks since real work" on its own. The counter therefore stores the transcript size at
# its last block and resets when tool activity appeared after it, the same progress signal
# stop-guard.sh uses. So at most AC_ANNOUNCE_GUARD_MAX_BLOCKS (default 2) blocks per stall, and
# Claude Code itself ends the turn after 8 consecutive blocks. The counter lives under TMPDIR,
# keyed by session id, so the guard writes nothing into projects that do not use ac.

set -u

max_blocks="${AC_ANNOUNCE_GUARD_MAX_BLOCKS:-2}"
case "$max_blocks" in
    '' | *[!0-9]*) max_blocks=2 ;;
esac
[ "$max_blocks" -gt 0 ] || exit 0

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

# Something already armed will wake the session; ending the turn is correct.
wake_count="$(printf '%s' "$input" | jq -r '((.background_tasks // []) | length) + ((.session_crons // []) | length)' 2>/dev/null)"
case "$wake_count" in '' | *[!0-9]*) wake_count=0 ;; esac
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

# Last non-empty paragraph with fenced blocks dropped, inline code removed, the dotted capital I
# folded (rg -i does not fold it), emphasis stripped; the last line is kept for the "?" test.
fences="$(printf '%s\n' "$msg" | awk '/^[[:space:]]*(```|~~~)/{n++} END{print n+0}')"
fence_filter='/^[[:space:]]*(```|~~~)/{f=!f; next} !f'
[ $((fences % 2)) -eq 0 ] || fence_filter='{print}'
tail_par="$(printf '%s\n' "$msg" \
    | awk "$fence_filter" \
    | awk 'BEGIN{RS=""} {p=$0} END{print p}' \
    | sed -e 's/İ/i/g' -e 's/`[^`]*`//g' -e 's/[*_]//g' -e 's/[[:space:]]*$//' \
    | tail -c 600)"
[ -n "$tail_par" ] || exit 0
last_line="$(printf '%s\n' "$tail_par" | awk 'NF{l=$0} END{print l}')"

match() { printf '%s' "$1" | rg --no-config -q -i "$2"; }

# A named blocker the user must clear is a legitimate end, even when phrased like a wait.
if match "$tail_par" '(s[ıi]ra(da|daki)\b.{0,40}\b(yok|kalmad[ıi])|\b(token|anahtar|parola|[şs]ifre|credential|password|sudo|login|giri[şs] yap|parmak izi|team_id|2fa|otp|e-?posta\w*|mail\w*|sms|do[ğg]rulama kodu)\b|\b(fiziksel|[öo]l[çc][üu]m[üu]n[üu]?|cihaz[ıi]n[ıi]?|kart[ıi]) .{0,40}(yap|tak|ba[ğg]la|[öo]l[çc])|nothing (left|remaining))'; then
    exit 0
fi

kind=""
if match "$tail_par" '(devam edeyim mi|devam ederim|devam edelim|ister misin|ister misiniz|istersen|isterseniz|onaylarsan|tercih ediyorsan|ne dersen|haz[ıi]r oldu[ğg]unda|yapay[ıi]m m[ıi]|edeyim mi|ba[şs]layay[ıi]m m[ıi]|\w{2,}(ay[ıi]m|eyim)\b|(senin|sizin) (istemen|onay[ıi]n|karar[ıi]n)|onay[ıi]n[ıi] bekliyorum|want me to|shall i\b|should i (continue|proceed|go ahead)|would you like me to|if you(.d| would) like me to|if you want me to|let me know if you|\b(m[ıiuü]|m[ıiuü]s[ıi]n|m[ıiuü]s[ıi]n[ıi]z)\?)'; then
    kind="offer"
elif match "$tail_par" '(devam ediyorum|devam edece[ğg]im|s[ıi]rada\b|s[ıi]radaki (ad[ıi]m|i[şs]|tur|commit|plan)|sonraki (ad[ıi]m|tur|i[şs])|a[çc][ıi]l[ıi]yor\b|izliyorum|takip ediyorum|(d[öo]n[üu]yorum|ge[çc]iyoruz|ba[şs]l[ıi]yoruz)|ge[çc]iyorum|ba[şs]l[ıi]yorum|[şs]imdi\b.{0,80}[ıiuü]yorum\b|(bitince|tamamlan[ıi]nca|gelince|olunca|d[öo]n[üu]nce|d[üu][şs][üu]nce)\b.{0,80}(r[ıiuü]m|ece[ğg]im|aca[ğg][ıi]m|ecek|acak)\b|bekliyorum|next,? i(.ll| will)\b|i.ll now\b|moving on to|proceeding (to|with)\b|^let me\b|i.m waiting|waiting (for|on) )' \
    || match "$tail_par" '(ece[ğg]im|aca[ğg][ıi]m)[;:,]' \
    || match "$last_line" '(ece[ğg]im|aca[ğg][ıi]m)[.!]?\s*$' \
    || { match "$last_line" '[ıiuü]yorum[.!]?\s*$' \
         && ! match "$last_line" '(öner|d[üu][şs][üu]n|g[öo]r|bil|anl|um|san|zannet|tahmin ed)[ıiuü]yorum[.!]?\s*$'; }; then
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
if [ -f "$counter" ]; then
    read -r prev_blocks prev_tpos < "$counter" 2>/dev/null || prev_blocks=0
    case "${prev_blocks:-}" in '' | *[!0-9]*) prev_blocks=0 ;; esac
    case "${prev_tpos:-}" in '' | *[!0-9]*) prev_tpos=0 ;; esac
    blocks="$prev_blocks"
    if [ "$prev_tpos" -gt 0 ] && [ "$tsize" -gt "$prev_tpos" ] \
        && tail -c "+$prev_tpos" "$transcript_path" 2>/dev/null | grep -q '"type":"tool_use"'; then
        blocks=0
    fi
fi
[ "$blocks" -lt "$max_blocks" ] || exit 0

blocks=$((blocks + 1))
printf '%s %s\n' "$blocks" "$tsize" > "$counter" 2>/dev/null || exit 0

case "$kind" in
    offer) found="Your last message offers to continue instead of continuing." ;;
    announce) found="Your last message announces a next step, or says you are waiting, without a tool call that does it." ;;
    question) found="Your last message ends on a question asked in prose, which ends the turn and stalls the work until the user returns." ;;
esac

reason="$found

End the turn only in one of three ways:
1. The work the user asked for is done and verified: end without offering more work.
2. A decision only the user can make blocks the rest, including an outward action (push, merge, PR, deploy, publish) the request did not name: finish everything that does not depend on it, then call AskUserQuestion with your recommendation first.
3. A blocker only the user can clear (a credential, a physical action, something deliberately protected from you): name it and say what you finished.

Otherwise, if that step is part of what the user asked for, take it now with its tool call. If it is extra work beyond the request, drop the offer and end. If the request was to explain, investigate or review, the report is the finished work: end without starting the fix. If the user asked you to stop or pause, end now. To wait on CI, a deploy or a bot, arm Monitor or Bash run_in_background before ending the turn. Context or token pressure is not a reason to stop; compaction carries the work forward."

jq -cn \
    --arg r "$reason" \
    --arg m "ac stop-guard-announce: blocked a $kind stop ($blocks/$max_blocks)" \
    '{decision: "block", reason: $r, systemMessage: $m}'
exit 0
