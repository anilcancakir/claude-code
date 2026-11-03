#!/bin/sh
# PreToolUse file-scope guard for ac plan execution.
#
# Denies a subagent (worker) file edit only when it targets a path OUTSIDE the active
# wave's declared file set under a FRESH run. Every other condition fails OPEN (exit 0,
# no output): the main-thread orchestrator, a dormant/absent marker, a stale marker from
# a crashed run, an in-scope or .ac/ path, and any parse or resolution uncertainty.
#
# It reads the per-slug markers .ac/state/execute/<slug>.json written by the execute skill
# (see plugins/ac/skills/execute/SKILL.md marker contract): wave_files drives the scope
# check, session_id decides whether this session owns the run, and started_at bounds its
# age. A session running two plans at once is scoped by the union of its fresh markers'
# wave_files; markers other sessions own are ignored. Denial is expressed as
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

# 1a. An ac:lane subagent is itself an execute orchestrator: its Phase 3 remediation edits
#     fall outside any wave's files, exactly like the main-thread orchestrator's. agent_type
#     carries the plugin namespace, so accept both forms, and match them exactly: the
#     plan-workers it spawns must stay gated.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
case "$agent_type" in
    ac:lane | lane) exit 0 ;;
esac

# Resolve the tree that holds the .ac/ state. The payload cwd follows a worktree; the stable
# root deliberately does not (utils/hooks.ts:813-816: "getProjectRoot() is never updated when
# entering a worktree"), and every .ac/ path in the execute skill is cwd-relative. So probe
# the payload cwd first, fall back to the stable root, and only then to PWD.
markers_lib="$(dirname "$0")/lib/execute-markers.sh"
[ -f "$markers_lib" ] || exit 0
. "$markers_lib"

payload_dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
project_dir=""
for _cand in "$payload_dir" "${CLAUDE_PROJECT_DIR:-}"; do
    [ -n "$_cand" ] || continue
    if [ -n "$(exec_markers "$_cand")" ]; then
        project_dir="$_cand"
        break
    fi
done
[ -n "$project_dir" ] || project_dir="${payload_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# 2. Ownership. Only the session that wrote a marker may be scoped by it. Without this
#    check a marker left by session A denies out-of-wave edits in an unrelated session B
#    working in the same repository, which is a false deny. No owned marker means no active
#    run of this session; the guard is dormant outside runs, so allow.
#
#    session_id is the signal, not pid. The orchestrator cannot learn its own process id
#    (a `$$` from Bash yields a short-lived subshell), and real markers in the field carry
#    `"pid": 0`, which passes `kill -0` only because pid 0 addresses the process group. The
#    pid check below is therefore retained as a cheap sanity filter, not a liveness proof.
hook_session="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$hook_session" ] || exit 0
owned="$(exec_owned_markers "$project_dir" "$hook_session")"
[ -n "$owned" ] || exit 0

now_epoch="$(date -u +%s 2>/dev/null)" || exit 0

# 2a. Staleness, per owned marker. To reach a denial we must POSITIVELY confirm a run is
#     fresh: a crashed run that skipped its Phase-4 delete must never brick the next session.
#     A marker whose freshness cannot be confirmed is skipped; with none fresh, allow.
#     The scope is the union of the fresh markers' wave_files. One fresh marker with an
#     empty or absent set leaves its scope undeclared, so no target can be confirmed out of
#     the union -> allow.
fresh=0
undeclared=""
wave_files=""
while IFS= read -r marker; do
    [ -n "$marker" ] || continue
    jq -e . "$marker" >/dev/null 2>&1 || continue

    started_at="$(jq -r '.started_at // empty' "$marker" 2>/dev/null)"
    [ -n "$started_at" ] || continue

    # Parse the ISO-8601 UTC timestamp. Try GNU date, then BSD date; a parse failure means
    # we cannot confirm freshness.
    started_epoch="$(date -u -d "$started_at" +%s 2>/dev/null)" \
        || started_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$started_at" +%s 2>/dev/null)" \
        || started_epoch=""
    [ -n "$started_epoch" ] || continue

    # Older than 24h, or a future timestamp (clock skew), cannot be confirmed fresh.
    age=$((now_epoch - started_epoch))
    { [ "$age" -ge 0 ] && [ "$age" -le 86400 ]; } || continue

    # The pid must be a live process; a missing, non-numeric, or dead pid is stale.
    pid="$(jq -r '.pid // empty' "$marker" 2>/dev/null)"
    case "$pid" in
        '' | *[!0-9]*) continue ;;
    esac
    kill -0 "$pid" 2>/dev/null || continue

    fresh=$((fresh + 1))
    files="$(jq -r '.wave_files[]? // empty' "$marker" 2>/dev/null)"
    if [ -n "$files" ]; then
        wave_files="$wave_files
$files"
    else
        undeclared=1
    fi
done <<EOF
$owned
EOF
[ "$fresh" -gt 0 ] || exit 0

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

# 3b. wave_files is the active waves' declared scope, collected at 2a. An undeclared set
#     means we cannot confirm the target is out of scope -> allow.
[ -z "$undeclared" ] || exit 0
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
