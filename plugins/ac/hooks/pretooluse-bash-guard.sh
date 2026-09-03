#!/bin/sh
# PreToolUse shell guard for /ac:auto runs.
#
# Denies a small closed list of irreversible shell verbs while an /ac:auto run this session
# owns is active. Every other condition fails OPEN (exit 0, no output): no marker, a marker
# owned by another session, an unreadable payload, an absent command, a missing jq, and any
# parse uncertainty. Failing open is the only tenable direction here: this hook sees every
# Bash call an unattended run makes, so a guard that failed closed on a parse error would
# break ordinary work rather than protect it.
#
# Why a verb list and not path analysis: deciding that `rm -rf ./build` is safe while
# `rm -rf ../..` is not requires resolving a path out of a shell word, which requires parsing
# shell grammar, which is an arms race this hook declines to enter. It matches whole tokens
# against literal verbs and nothing else.
#
# The list stands at twelve, and the threshold the design review set was about ten: past that, the
# right move is to run the whole thing in a git worktree and delete this hook, not to keep adding
# spellings. Three of the twelve are flag variants of entries already present (`rm -fr`,
# `git checkout .`, `git restore .`), added because leaving a trivial reordering out while listing
# its sibling misleads more than it protects. That is the last addition this file should take.
# Worktree isolation is recorded in the plan's Deferred Ideas and this comment is the trigger for it.
#
# Why the orchestrator is NOT exempt, unlike pretooluse-file-scope.sh: that hook's predicate is
# wave file scope, a worker concept, and the orchestrator legitimately writes outside every
# wave (plan checkboxes, evidence), so an absent agent_id means allow there. This predicate is
# "an irreversible verb during an unattended run", which is true of whoever typed it. The
# orchestrator is the main thread of an auto run and therefore its largest single source of
# shell commands; exempting it would leave the shell effectively ungated, which is the exact
# hole this hook exists to close. So no agent_id branch below: the guard applies to the
# orchestrator and to every subagent alike.
#
# Scope note: the plugin's other PreToolUse guard matches Edit|Write|MultiEdit only, so until
# this one is registered on the Bash matcher an auto run has no control on the shell at all.
#
# Known limits, all in the SAME direction: this guard under-matches. It is a speed bump against an
# unthinking destructive call, not a boundary against an adversary, and every gap below was measured
# by running the script rather than reasoned about.
#   - Quoting defeats it entirely. `git "push"`, `git 'push'`, `eval "git push"` and `rm "-rf" x`
#     all pass, because the token test sees `git`, `"push"` as separate words. The same property
#     means `echo "git push"` is correctly allowed rather than falsely denied, which is a nice
#     accident and not a design goal.
#   - A verb reached through a path or an alias (`/bin/rm -rf`, `g push`) is not matched.
#   - Flag spellings outside the list pass: `sed --in-place`, `perl -i -pe`, `sed -i.bak`.
#   - Everything the list does deny lands on files that a wave checkpoint commit already captured,
#     which is why the guard can afford to be this porous. What it buys is that the obvious
#     irreversible call does not happen by reflex during an unattended run.
#   - The marker is a single global slot per repository, and ownership is the session id, so a
#     second concurrent run in one repository leaves the first unguarded.
#   - No staleness bound. A marker outliving its run keeps the guard armed for that session
#     only, and a deny costs one command rather than trapping the session, so the age check the
#     Stop guards carry buys nothing here.

set -u

# 0. Read the payload. jq is the only parser; without either, we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Resolve the tree that holds the .ac/ state. The payload cwd follows a worktree; the stable
#    root deliberately does not (utils/hooks.ts:813-816: "getProjectRoot() is never updated when
#    entering a worktree"), and every .ac/ path the auto skill writes is cwd-relative. So probe
#    the payload cwd first, fall back to the stable root, and only then to PWD. Each candidate
#    is re-checked for the marker: picking a directory and testing for the marker afterwards
#    would settle on a tree that never had one.
payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
project_dir=""
for _cand in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$_cand" ] || continue
    if [ -e "$_cand/.ac/state/active-auto.json" ]; then
        project_dir="$_cand"
        break
    fi
done
[ -n "$project_dir" ] || project_dir="${payload_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"

marker="$project_dir/.ac/state/active-auto.json"

# 2. No marker means no unattended run. The guard is dormant outside /ac:auto, so allow.
[ -f "$marker" ] || exit 0
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 3. Ownership. Only the session that wrote the marker may be gated by it, so a marker left
#    behind by another session cannot deny commands in an unrelated session working in the same
#    repository. session_id is the signal, not pid: the orchestrator cannot learn its own
#    process id (a `$$` from Bash yields a short-lived subshell), and real markers in the field
#    carry `"pid": 0`, which passes `kill -0` only because pid 0 addresses the process group.
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
marker_session="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
[ -n "$marker_session" ] || exit 0
[ "$hook_session" = "$marker_session" ] || exit 0

# 4. The command under inspection. Nothing to match means nothing to deny, so allow.
command_text="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$command_text" ] || exit 0

# 5. Tokenize by whitespace only. Shell separators become spaces so `a;rm -rf x` reads the same
#    as `a && rm -rf x`; that is lexical normalization, not grammar parsing, and it stops the
#    list from being defeated by a missing space. Padding both ends lets a single substring test
#    per verb match on token boundaries, so `xrm -rf` and `--git push` do not fire.
haystack=" $(printf '%s' "$command_text" | tr '\n\r\t;&|()' '        ' | tr -s ' ') "

# 6. The closed list. One verb phrase per line, matched literally as a token sequence.
matched=""
while IFS= read -r verb; do
    [ -n "$verb" ] || continue
    case "$haystack" in
        *" $verb "*)
            matched="$verb"
            break
            ;;
    esac
done <<'VERBS'
rm -rf
rm -fr
git reset --hard
git checkout -- .
git checkout .
git restore .
git clean
git push
gh pr merge
gh release
sed -i
perl -pi
VERBS

[ -n "$matched" ] || exit 0

# 7. Confirmed: an irreversible verb, under an auto-run marker this session owns. This is the
#    only path that denies. The reason is shown to Claude (docs/hooks.md:1165), so it names the
#    matched verb and what to do instead, rather than only refusing.
reason="ac auto guard: '$matched' is not available during an unattended /ac:auto run.

This run has no user watching it, so the verbs that cannot be undone from inside the session are
off the table: rm -rf, git reset --hard, git checkout -- ., git clean, git push, gh pr merge,
gh release, sed -i, perl -pi.

Reach the same outcome another way: edit files with the Edit tool rather than sed -i or perl -pi,
remove a path with a plain rm of the named files, and leave publishing (push, merge, release) and
history rewriting to the user after the verdict. If the run genuinely cannot proceed without this
command, record that in the verdict as a blocker instead of working around the guard.

If no /ac:auto run is actually in progress, this guard is armed by a marker left behind by an
interrupted one: delete .ac/state/active-auto.json and the command will be allowed. The marker
carries no age bound, so it stays armed for this session until it is removed."

jq -cn --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
