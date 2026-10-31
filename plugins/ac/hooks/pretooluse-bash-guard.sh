#!/bin/sh
# PreToolUse away guard for /ac:auto runs, registered on Bash and AskUserQuestion.
#
# Applies only while this session owns .ac/state/active-auto.json, the away marker.
#   - AskUserQuestion is denied: the user is away, so the skill takes the Recommended option and logs
#     it in the decisions file. This is the deterministic backstop for a flow body (plan, execute,
#     coordinate) that still says to ask. It needs a live marker (24 h, 72 h over a coordinator run,
#     the bounds the Stop guards use), because a stale one would silence every question in the session.
#   - Bash, always denied: the irreversible local verbs (a force push, a push that deletes remote refs,
#     a hard reset, a clean that is not a dry run, a checkout or restore of the whole tree, a recursive
#     forced rm) plus `sed -i` and `perl -i`, which belong to the Edit tool.
#   - Bash, outward, allowed only when the marker's `allowed_outward` names them: `git push` (push),
#     `gh pr create` (pr), `gh pr merge` (merge), `gh release create|delete|edit|upload` (release).
#     `pr` also allows the push its branch needs, and `merge` the push and the PR, since neither can
#     land without them; the skill writes `push` itself when a deploy is push-triggered. `deploy` has no verb here: deploy
#     commands are project-specific, so the skill body is what keeps an unnamed one from running.
# Every other condition fails OPEN (exit 0, no output): no marker, a marker owned by another session,
# an unreadable payload, an absent command, a missing jq or awk. A guard that failed closed on a parse
# error would break ordinary work on every call of an unattended run rather than protect it.
#
# How a command is read: backslash-newline continuations are joined, the text is split into
# segments at newline, ;, &, |, parentheses and backticks, quotes are dropped from each token, and a
# verb counts only at the segment's command position (after VAR=value, env, command, exec, nohup,
# time, sudo, timeout N and shell keywords), with git's global options (-C dir, -c key=value,
# --git-dir, --work-tree) skipped. So `git commit -m "never git push"` and `echo git push` pass,
# and `git -C ../wt push --force` does not. This is lexical normalisation, not shell parsing.
#
# The orchestrator is not exempt (no agent_id branch): the predicate is "an irreversible verb during
# an unattended run", which holds whoever typed it, and the main thread is an away run's largest
# source of shell commands.
#
# Known limits, all toward under-matching: a verb reached through eval, an alias or a variable
# (`g push`, `$GIT push`) is not seen; a quoted separator splits a segment early, which can deny a
# commit message that spells out a destructive command after a `;`. The Bash side carries no age
# bound: a deny costs one command, and its reason says how to clear a marker left behind.

set -u

# 0. Read the payload. jq and awk are the parsers; without them we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v awk >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Resolve the tree that holds the .ac/ state. The payload cwd follows a worktree; the stable
#    root does not (utils/hooks.ts:813-816), and every .ac/ path the skill writes is cwd-relative.
payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
project_dir=""
for _cand in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$_cand" ] || continue
    if [ -e "$_cand/.ac/state/active-auto.json" ]; then
        project_dir="$_cand"
        break
    fi
done
[ -n "$project_dir" ] || exit 0

marker="$project_dir/.ac/state/active-auto.json"
[ -f "$marker" ] || exit 0
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 2. Ownership by session_id: a marker left by another session never gates this one.
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

decisions="$(jq -r '.decisions // empty' "$marker" 2>/dev/null)"
[ -n "$decisions" ] || decisions=".ac/away/<slug>/decisions.md"

deny() {
    jq -cn --arg r "$1" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $r
      }
    }'
    exit 0
}

# 3. AskUserQuestion: deny under a live marker.
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"
if [ "$tool_name" = "AskUserQuestion" ]; then
    max_age=86400
    [ "$(jq -r '.source // empty' "$marker" 2>/dev/null)" = "coordinate" ] && max_age=259200
    started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
    [ -n "$started_at" ] || exit 0
    started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
        || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
        || exit 0
    now_epoch="$(date -u +%s 2>/dev/null)" || exit 0
    age=$((now_epoch - started_epoch))
    # A model-written local time with a trailing Z reads as up to 14 h in the future.
    { [ "$age" -ge -50400 ] && [ "$age" -le "$max_age" ]; } || exit 0

    deny "ac away guard: the user is away and this session owns the ac:auto away run, so no question reaches them.

Take the option the flow marks Recommended (a flow gate's default), apply it, and add one line under ## Decisions in $decisions: time | source | question | chosen option | why | not user-approved. If the question is a true blocker (a destructive or irreversible action, an outward action the user did not name, a finding that the plan is wrong, a missing secret or credential), add it under ## Blocked in the same file instead and continue every other independent part of the run."
fi

[ "$tool_name" = "Bash" ] || exit 0

# 4. The command under inspection. Nothing to match means nothing to deny, so allow.
command_text="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$command_text" ] || exit 0

allowed="$(jq -r '(.allowed_outward // []) | if type == "array" then .[] | strings else empty end' \
    "$marker" 2>/dev/null)"

is_allowed() {
    printf '%s\n' "$allowed" | grep -Fqx "$1" && return 0
    # A PR needs its branch pushed, and a merge needs both the PR and the push.
    case "$1" in
        push) printf '%s\n' "$allowed" | grep -Fqx -e pr -e merge ;;
        pr) printf '%s\n' "$allowed" | grep -Fqx merge ;;
        *) return 1 ;;
    esac
}

# 5. Classify every segment. Prints one `verb|value` line per hit; an empty value means always denied.
classifier='
function flagged(t) { return t ~ /^-[^-]/ }
{
    n = split($0, raw, " ")
    k = 0
    for (i = 1; i <= n; i++) {
        t = raw[i]
        gsub(/["\047]/, "", t)
        if (t != "") tok[++k] = t
    }
    p = 1
    while (p <= k) {
        t = tok[p]
        if (t ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { p++; continue }
        if (t == "timeout") {
            p++
            while (p <= k && tok[p] ~ /^-/) {
                if (tok[p] == "-s" || tok[p] == "-k" || tok[p] == "--signal" || tok[p] == "--kill-after") p++
                p++
            }
            p++
            continue
        }
        if (t == "env" || t == "command" || t == "exec" || t == "nohup" || t == "time" || t == "sudo" \
            || t == "!" || t == "{" || t == "if" || t == "then" || t == "else" || t == "elif" \
            || t == "do" || t == "while" || t == "until") {
            p++
            while (p <= k && tok[p] ~ /^-/) p++
            continue
        }
        break
    }
    if (p > k) next
    cmd = tok[p]
    sub(/.*\//, "", cmd)

    if (cmd == "rm") {
        r = 0; f = 0
        for (i = p + 1; i <= k; i++) {
            t = tok[i]
            if (t == "--") break
            if (t == "--recursive") r = 1
            else if (t == "--force") f = 1
            else if (flagged(t)) { if (t ~ /[rR]/) r = 1; if (t ~ /f/) f = 1 }
        }
        if (r && f) print "rm -rf|"
        next
    }
    if (cmd == "sed") {
        for (i = p + 1; i <= k; i++) {
            t = tok[i]
            if (t ~ /^--in-place/ || (flagged(t) && t ~ /^-[A-Za-z]*i/)) { print "sed -i|"; next }
        }
        next
    }
    if (cmd == "perl") {
        for (i = p + 1; i <= k; i++) {
            t = tok[i]
            if (flagged(t) && t ~ /^-[0-9aFlnpsTtuUWwXx]*i/) { print "perl -i|"; next }
        }
        next
    }
    if (cmd == "git") {
        q = p + 1
        while (q <= k) {
            t = tok[q]
            if (t == "-C" || t == "-c" || t == "--git-dir" || t == "--work-tree" || t == "--namespace") { q += 2; continue }
            if (t ~ /^-/) { q++; continue }
            break
        }
        if (q > k) next
        sc = tok[q]
        if (sc == "reset") {
            for (i = q + 1; i <= k; i++) if (tok[i] == "--hard") { print "git reset --hard|"; next }
            next
        }
        if (sc == "clean") {
            dry = 0
            for (i = q + 1; i <= k; i++) {
                t = tok[i]
                if (t == "--dry-run" || (flagged(t) && t ~ /n/)) dry = 1
            }
            if (!dry) print "git clean|"
            next
        }
        if (sc == "checkout" || sc == "restore") {
            for (i = q + 1; i <= k; i++) if (tok[i] == ".") { print "git " sc " .|"; next }
            next
        }
        if (sc == "push") {
            force = 0; del = 0
            for (i = q + 1; i <= k; i++) {
                t = tok[i]
                if (t == "--force" || t ~ /^--force-with-lease/ || t == "--force-if-includes") force = 1
                else if (t == "--mirror" || t == "--delete" || t == "--prune") del = 1
                else if (flagged(t)) { if (t ~ /f/) force = 1; if (t ~ /d/) del = 1 }
                else if (t ~ /^\+/) force = 1
                else if (t ~ /^:/) del = 1
            }
            if (force) print "git push --force|"
            else if (del) print "git push --delete|"
            else print "git push|push"
            next
        }
        next
    }
    if (cmd == "gh") {
        a = (p + 1 <= k) ? tok[p + 1] : ""
        b = (p + 2 <= k) ? tok[p + 2] : ""
        if (a == "pr" && b == "merge") print "gh pr merge|merge"
        else if (a == "pr" && b == "create") print "gh pr create|pr"
        else if (a == "release" && (b == "create" || b == "delete" || b == "edit" || b == "upload" \
            || b == "delete-asset")) print "gh release " b "|release"
        next
    }
}'

hits="$(printf '%s\n' "$command_text" \
    | tr -d '\r' \
    | awk '{ if (sub(/\\$/, "")) printf "%s ", $0; else print }' \
    | tr ';&|()`' '\n\n\n\n\n\n' \
    | awk "$classifier" 2>/dev/null)" || exit 0
[ -n "$hits" ] || exit 0

# 6. The first hit that is not an allowed outward verb decides; an allowed one lets the scan go on,
#    so `git push && git push --force` is still denied.
matched=""
needs=""
while IFS= read -r _hit; do
    [ -n "$_hit" ] || continue
    _verb="${_hit%%|*}"
    _need="${_hit#*|}"
    if [ -n "$_need" ] && is_allowed "$_need"; then
        continue
    fi
    matched="$_verb"
    needs="$_need"
    break
done <<EOF
$hits
EOF

[ -n "$matched" ] || exit 0

# 7. Confirmed: a denied verb under an away marker this session owns. The reason is shown to Claude
#    (docs/hooks.md:1165), so it names the verb and the way forward rather than only refusing.
if [ -n "$needs" ]; then
    why="'$matched' is an outward action, and this away run's allowed_outward list does not name '$needs': the user's request did not ask for it."
else
    why="'$matched' cannot be undone from inside the session (or, for sed -i and perl -i, belongs to the Edit tool), so it stays denied under any away run whatever the request named."
fi

deny "ac away guard: $why

Record the action as deferred under ## Blocked in $decisions (what, why it was denied) and continue every other independent part of the run; the user picks it up from the closing report. Edit files with the Edit tool and remove named files with a plain rm. Do not work around this guard.

If no away run is in progress, the marker .ac/state/active-auto.json was left behind by an interrupted one: delete it and the command is allowed."
