# Per-slug /ac:execute markers, sourced by every hook that reads them (pretooluse-file-scope.sh,
# stop-guard.sh, stop-guard-auto.sh, stop-guard-announce.sh, session-start-plan-state.sh,
# posttooluse-question-timeout.sh).
#
# Each running plan owns .ac/state/execute/<slug>.json, so several runs can share one checkout. The
# Stop guard keeps its block counter beside it as <slug>.stop-guard.json, which the *.json glob also
# matches; it is skipped here so no caller ever reads a counter as a run. A file name outside
# [A-Za-z0-9._-] is not a slug the execute skill writes, so it is ignored rather than trusted: the
# slug ends up in paths and in text handed to the model.
#
# Plain sh, no jq, except exec_owned_markers. Every function prints nothing and returns non-zero on
# anything it cannot judge.

# Prints the slug a marker path names, or fails for a counter or a name outside the charset.
exec_marker_slug() {
    _em_base="${1##*/}"
    _em_base="${_em_base%.json}"
    case "$_em_base" in '' | *.stop-guard | *[!A-Za-z0-9._-]*) return 1 ;; esac
    printf '%s' "$_em_base"
}

# Usage: exec_markers <project_dir>. Prints one marker path per line.
exec_markers() {
    [ -n "${1:-}" ] || return 1
    for _em_file in "$1"/.ac/state/execute/*.json; do
        [ -f "$_em_file" ] || continue
        exec_marker_slug "$_em_file" >/dev/null || continue
        printf '%s\n' "$_em_file"
    done
}

# Usage: exec_owned_markers <project_dir> <session_id>. Prints the markers whose session_id equals
# the given one. Ownership is the only test here; each caller applies its own age bound.
exec_owned_markers() {
    [ -n "${2:-}" ] || return 1
    exec_markers "$1" | while IFS= read -r _em_file; do
        [ "$(jq -r '.session_id // empty' "$_em_file" 2>/dev/null)" = "$2" ] && printf '%s\n' "$_em_file"
    done
}
