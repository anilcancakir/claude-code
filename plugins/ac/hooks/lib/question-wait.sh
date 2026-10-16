# Question-wait latch, sourced by the three Stop guards (stop-guard.sh, stop-guard-auto.sh,
# stop-guard-announce.sh) and written by the AskUserQuestion timeout hook.
#
# A turn that ends to wait for a question that timed out is the correct ending, so no Stop guard may
# block it. The latch is a file under TMPDIR keyed by session id, holding the epoch it was armed at.
# qw_active never deletes it: the three guards are parallel registrations that all see the same Stop
# event, so a guard that consumed the latch would leave the next one blocking. It expires by age
# instead (600 s); qw_clear is for the code that armed it.
#
# Plain sh, no jq. Every function returns non-zero on anything it cannot judge, which callers read
# as "no latch" and so fall back to their normal behaviour.

# Prints the latch path. A session id outside [A-Za-z0-9-] (a slash, a dot-dot, a space) never
# reaches the filesystem, the same charset check stop-guard-announce.sh applies to its counter.
qw_path() {
    case "${1:-}" in '' | *[!A-Za-z0-9-]*) return 1 ;; esac
    printf '%s' "${TMPDIR:-/tmp}/ac-question-wait-$1"
}

qw_arm() {
    _qw_file="$(qw_path "${1:-}")" || return 1
    [ -L "$_qw_file" ] && return 1
    date -u +%s > "$_qw_file" 2>/dev/null
}

qw_active() {
    _qw_file="$(qw_path "${1:-}")" || return 1
    [ -f "$_qw_file" ] && [ ! -L "$_qw_file" ] || return 1
    read -r _qw_epoch < "$_qw_file" 2>/dev/null
    # A leading zero would read as octal inside $(( )), and a bad octal aborts a non-interactive sh.
    case "${_qw_epoch:-}" in '' | 0* | *[!0-9]*) return 1 ;; esac
    _qw_now="$(date -u +%s 2>/dev/null)" || return 1
    _qw_age=$((_qw_now - _qw_epoch))
    [ "$_qw_age" -ge 0 ] && [ "$_qw_age" -le 600 ]
}

qw_clear() {
    _qw_file="$(qw_path "${1:-}")" || return 1
    rm -f "$_qw_file" 2>/dev/null
}
