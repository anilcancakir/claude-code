#!/bin/sh
# SessionStart hook: surface the in-progress ac plan as resume context.
#
# Scans .ac/plans/*/plan.md for a plan carrying unchecked "- [ ]" steps and emits a
# one-line additionalContext hint ("<slug>: wave X, next unchecked step: <title>").
# Advisory only: prints nothing and exits 0 on any error or when no plan is in progress,
# so a broken scan never blocks a session start.

set -u

# jq parses both the payload and the marker; without it we cannot reason, so stay silent.
command -v jq >/dev/null 2>&1 || exit 0

# The payload carries the project cwd; fall back to PWD when it is absent.
input="$(cat 2>/dev/null)" || exit 0
project_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$project_dir" ] || project_dir="$PWD"

plans_dir="$project_dir/.ac/plans"
[ -d "$plans_dir" ] || exit 0

# 1. Find the in-progress plan: the first plan.md with an unchecked top-level step.
plan_file=""
for f in "$plans_dir"/*/plan.md; do
    [ -f "$f" ] || continue
    if grep -q '^- \[ \] ' "$f" 2>/dev/null; then
        plan_file="$f"
        break
    fi
done
[ -n "$plan_file" ] || exit 0

# 2. Slug is the plan directory name.
slug="$(basename "$(dirname "$plan_file")")"

# 3. Next unchecked step title: the text after the "- [ ] **Step N**: " prefix.
next_step="$(grep -m1 '^- \[ \] ' "$plan_file" 2>/dev/null | sed -E 's/^- \[ \] \*\*[^*]*\*\*: *//')"
[ -n "$next_step" ] || exit 0

# 4. Current wave comes from the active-execution marker when it is present and names
#    this same run; otherwise default to 1. The marker is the only machine-readable wave
#    source (plan.md holds no per-step wave field), so a cold startup with no active run
#    reports the first wave as a starting hint.
wave="1"
marker="$project_dir/.ac/state/active-execution.json"
if [ -f "$marker" ]; then
    marker_slug="$(jq -r '.slug // empty' "$marker" 2>/dev/null)"
    if [ "$marker_slug" = "$slug" ]; then
        current_wave="$(jq -r '.current_wave // empty' "$marker" 2>/dev/null)"
        [ -n "$current_wave" ] && wave="$current_wave"
    fi
fi

context="$slug: wave $wave, next unchecked step: $next_step"
jq -cn --arg c "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $c
  }
}'
exit 0
