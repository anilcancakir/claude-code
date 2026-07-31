#!/bin/sh
# SessionStart hook: surface ac plan state as resume context.
#
# Emits an additionalContext block describing the active plan: which plan it is, how many
# steps remain, the next unchecked step, and recent commits. On the `compact` source it also
# states what compaction did to the workflow skill bodies, because `docs/skills.md:298-300`
# keeps only the first 5,000 tokens of a re-attached skill and both ac workflow bodies are
# far larger than that.
#
# Everything here is phrased as factual statements about the repository, never as imperative
# instructions: docs/hooks.md:692 warns that out-of-band command phrasing in
# additionalContext can trip prompt-injection defenses and get surfaced to the user instead
# of read as context. Directives live in the skill bodies and in stop-guard.sh's `reason`
# field, which is the documented channel for them.
#
# Advisory only: prints nothing and exits 0 on any error or when no plan is in progress, so
# a broken scan never blocks a session start.

set -u

# jq parses both the payload and the marker; without it we cannot reason, so stay silent.
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat 2>/dev/null)" || exit 0
project_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$project_dir" ] || project_dir="$PWD"
source_kind="$(printf '%s' "$input" | jq -r '.source // empty' 2>/dev/null)"

plans_dir="$project_dir/.ac/plans"
[ -d "$plans_dir" ] || exit 0

marker="$project_dir/.ac/state/active-execution.json"

# 1. Identify the plan. The marker names the active run and is authoritative when present.
#    A repository accumulates plan directories run after run, so scanning for the first one
#    with an unchecked step names the wrong plan whenever a marker exists.
slug=""
wave=""
marker_note=""
if [ -f "$marker" ] && jq -e . "$marker" >/dev/null 2>&1; then
    slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
    wave="$(jq -r '.current_wave // empty' "$marker" 2>/dev/null)"
    marker_note="$(jq -r '.note // empty' "$marker" 2>/dev/null)"
    [ -n "$slug" ] && [ -f "$plans_dir/$slug/plan.md" ] || slug=""
fi

if [ -z "$slug" ]; then
    # No usable marker: fall back to the first plan carrying an unchecked top-level step.
    for f in "$plans_dir"/*/plan.md; do
        [ -f "$f" ] || continue
        if grep -q '^- \[ \] ' "$f" 2>/dev/null; then
            slug="$(basename "$(dirname "$f")")"
            break
        fi
    done
fi
[ -n "$slug" ] || exit 0

plan_file="$plans_dir/$slug/plan.md"
[ -f "$plan_file" ] || exit 0

# 2. Step counts straight from the plan file, which the execute skill treats as the
#    authoritative record of what remains.
unchecked="$(grep -c '^- \[ \] ' "$plan_file" 2>/dev/null || true)"
checked="$(grep -c '^- \[x\] ' "$plan_file" 2>/dev/null || true)"
case "$unchecked" in '' | *[!0-9]*) unchecked=0 ;; esac
case "$checked" in '' | *[!0-9]*) checked=0 ;; esac
total=$((unchecked + checked))
[ "$total" -gt 0 ] || exit 0

# Nothing outstanding and no marker means there is no resume state worth reporting.
if [ "$unchecked" -eq 0 ] && [ ! -f "$marker" ]; then
    exit 0
fi

next_step="$(grep -m1 '^- \[ \] ' "$plan_file" 2>/dev/null | sed -E 's/^- \[ \] \*\*[^*]*\*\*: *//')"

context="ac plan state for this repository:
- Active plan: $slug ($checked of $total steps checked, $unchecked unchecked).
- Authoritative step state lives in .ac/plans/$slug/plan.md; the session task list mirrors it."

[ -n "$wave" ] && context="$context
- Marker .ac/state/active-execution.json reports wave $wave, so an /ac:execute run was in flight."
[ -n "$marker_note" ] && context="$context
- Marker note: $marker_note"
[ -n "$next_step" ] && context="$context
- First unchecked step: $next_step"

# 3. Recent commits are a second, independent record of progress. Anthropic's
#    cwc-long-running-agents session ritual pairs its progress file with `git log` for the
#    same reason: a state file can drift, the history cannot.
if git -C "$project_dir" rev-parse --git-dir >/dev/null 2>&1; then
    log="$(git -C "$project_dir" log --oneline -5 2>/dev/null)"
    if [ -n "$log" ]; then
        context="$context
- Last 5 commits:
$(printf '%s\n' "$log" | sed 's/^/    /')"
    fi
fi

# 4. On the compact source, state what compaction did to the workflow skill bodies. Both are
#    well past the 5,000-token retention, so their loop bounds, terminal branches, and error
#    handling have left the context window.
if [ "$source_kind" = "compact" ]; then
    context="$context
- This session resumed from a compaction. Compaction is a routine event in the ac workflow and does not end a run: older turns are summarized and work continues from the plan file.
- A re-attached skill keeps only its first 5,000 tokens. The ac:plan body is roughly 16,000 tokens and ac:execute roughly 14,000, so each one's later sections (loop bounds, terminal branches, error handling, deliver phase) are no longer in context. Re-invoking the relevant skill restores its full body."
fi

jq -cn --arg c "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $c
  }
}'
exit 0
