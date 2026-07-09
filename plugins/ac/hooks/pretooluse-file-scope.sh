#!/bin/sh
# PreToolUse file-scope guard for ac plan execution.
#
# Denies a subagent (worker) file edit only when it targets a path OUTSIDE the active
# wave's declared file set under a FRESH run. Every other condition fails OPEN (exit 0,
# no output): the main-thread orchestrator, a dormant/absent marker, a stale marker from
# a crashed run, an in-scope or .ac/ path, and any parse or resolution uncertainty.
#
# It reads the active-execution marker written by the execute skill
# (see plugins/ac/skills/execute/SKILL.md marker contract): wave_files drives the scope
# check; pid and started_at drive the staleness check. Denial is expressed as
# permissionDecision:"deny" JSON on stdout with exit 0; exit 2 is never used, because a
# non-zero crash also fails open by design.

set -u

# 0. Read the payload. jq is the only parser; without either, we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# 1. agent_id absent means the main-thread orchestrator (present only in subagent calls).
#    Never gate the orchestrator's own writes (plan.md checkbox ticks, remediation).
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)" || exit 0
[ -n "$agent_id" ] || exit 0

# Resolve the project directory from the payload cwd; fall back to PWD.
project_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$project_dir" ] || project_dir="$PWD"

marker="$project_dir/.ac/state/active-execution.json"

# 2. No marker means no active run; the guard is dormant outside runs, so allow.
[ -f "$marker" ] || exit 0

# A malformed marker is uncertainty, so allow.
jq -e . "$marker" >/dev/null 2>&1 || exit 0

# 2b. Staleness. To reach a denial we must POSITIVELY confirm the run is fresh: a crashed
#     run that skipped its Phase-4 delete must never brick the next session. Any failure to
#     confirm freshness falls open.
now_epoch="$(date -u +%s 2>/dev/null)" || exit 0

started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
[ -n "$started_at" ] || exit 0

# Parse the ISO-8601 UTC timestamp. Try GNU date, then BSD date; a parse failure means we
# cannot confirm freshness, so allow.
started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
    || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
    || started_epoch=""
[ -n "$started_epoch" ] || exit 0

# Older than 24h, or a future timestamp (clock skew), cannot be confirmed fresh -> allow.
age=$((now_epoch - started_epoch))
{ [ "$age" -ge 0 ] && [ "$age" -le 86400 ]; } || exit 0

# The pid must be a live process; a missing, non-numeric, or dead pid is stale -> allow.
pid="$(jq -r '.pid // empty' "$marker" 2>/dev/null)"
case "$pid" in
    '' | *[!0-9]*) exit 0 ;;
esac
kill -0 "$pid" 2>/dev/null || exit 0

# 3. Resolve the tool's target path. No path means nothing to scope -> allow.
target="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$target" ] || exit 0

# Canonicalize a path to an absolute, symlink-free, case-folded form (macOS APFS is
# case-insensitive by default). Resolves new-file targets via the existing parent so a
# Write that creates a file still canonicalizes. Prints nothing when it cannot resolve.
canon() {
    _p="$1"
    case "$_p" in /*) ;; *) _p="$project_dir/$_p" ;; esac
    # Walk up to the first existing ancestor and realpath-resolve it, then re-append the
    # nonexistent tail. This keeps a new-file target symlink-resolved consistently with an
    # existing path (macOS /var -> /private/var); a one-level dirname fallback would leave a
    # deeply-nonexistent path raw and mismatch a resolved prefix, wrongly failing the .ac/
    # and wave_files checks (a fail-CLOSED bug).
    if command -v realpath >/dev/null 2>&1; then
        _tail=""
        _cur="$_p"
        while [ -n "$_cur" ] && [ "$_cur" != "/" ]; do
            if _r="$(realpath "$_cur" 2>/dev/null)"; then
                printf '%s' "$_r$_tail" | tr '[:upper:]' '[:lower:]'
                return 0
            fi
            _tail="/$(basename "$_cur")$_tail"
            _cur="$(dirname "$_cur")"
        done
    fi
    printf '%s' "$_p" | tr '[:upper:]' '[:lower:]'
}

target_canon="$(canon "$target")"
[ -n "$target_canon" ] || exit 0

# Anything under .ac/ is always allowed (plan.md, the marker, evidence, wisdom).
ac_canon="$(canon "$project_dir/.ac")"
case "$target_canon" in
    "$ac_canon"/*) exit 0 ;;
esac

# 3b. wave_files is the active wave's declared scope. An empty or absent set means the
#     allowed set is undeclared, so we cannot confirm the target is out of scope -> allow.
wave_files="$(jq -r '.wave_files[]? // empty' "$marker" 2>/dev/null)"
[ -n "$wave_files" ] || exit 0

# 4. Compare the target against each declared wave file. A match means in-scope -> allow.
printf '%s\n' "$wave_files" | while IFS= read -r wf; do
    [ -n "$wf" ] || continue
    [ "$(canon "$wf")" = "$target_canon" ] && exit 3
done
# The subshell exits 3 on a match; propagate that as an allow.
[ "$?" -eq 3 ] && exit 0

# 5. Confirmed: a worker edit, under a fresh marker, targeting a path outside the active
#    wave's files and not under .ac/. This is the only path that denies.
jq -cn --arg r "Edit outside active step scope: $target" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
