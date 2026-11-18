#!/bin/sh
# Hook for the ten events iTerm2's Claude Code integration listens on: forwards the payload to
# iTerm2's cc-status, which sets the tab's status dot, with a cached API cookie in ITERM2_COOKIE.
#
# Why not register cc-status directly, as iTerm2's installer does: with no ITERM2_COOKIE in the
# environment, it2 asks iTerm2 for a single-use cookie on every hook, through osascript on iTerm2
# 3.7.7. Every osascript run leaves WindowServer holding Mach ports it never gives back; measured
# on 2026-11-18, a busy machine grew about 25 ports a minute, reached the kernel's port-space
# limit (305,834) after 6.7 days, the kernel killed WindowServer and loginwindow ended the
# session. With ITERM2_COOKIE set, it2 takes the fast path of CookieAuth.getCredentials and asks
# nothing, whether the cookie is valid or not (40 runs with a bogus cookie started no osascript).
#
# iTerm2 keeps cookies in memory only (iTermWebSocketCookieJar.m), so a cookie lives as long as
# the iTerm2 process that issued it: the cache holds "<iTerm2 pid>@<start time> <cookie>". When
# that no longer names the running iTerm2, the hook skips cc-status (the dot goes stale instead
# of leaking) and asks iTerm2 for a reusable cookie in the background, which shows "it2 requests
# a reusable API cookie." in the tab. The hook runs that osascript itself rather than through
# `it2 auth cookie`, whose AppleEvent gives up after AppleScript's default 120 s and drops a late
# answer. A lock per iTerm2 pid allows one request an hour, so a missed or denied announcement
# costs one osascript an hour instead of one per hook.
#
# A cookie is cached only after two `it2 session get-status` calls accept it: iTerm2 hands out a
# single-use cookie when it has no session to show the announcement in, and that passes once.
# A cached cookie is probed the same way at most once an hour, and dropped when refused, which
# covers the "24 Hours" answer expiring under a still-running iTerm2.
#
# Opt-in: nothing runs until the cache file exists (`touch ~/.config/iterm2/ac-agent-cookie`), so
# the plugin never raises an announcement on its own. docs/terminal-setup.md has the setup,
# including removing the installer's direct cc-status hooks, which would keep leaking.
#
# ITERM2_KEY is dropped: it2 3.7.7 fails authentication when an env cookie comes with a key.
#
# Fail open: exits 0 and prints nothing whenever it does not forward.

set -u

dir="$HOME/.config/iterm2"
cache="$dir/ac-agent-cookie"
cc_status="$dir/cc-status"

skip() {
    cat > /dev/null
    exit 0
}

# Replaces the cache in one rename, so a concurrent hook reads the old line or the new one.
write_cache() {
    staged=$(mktemp "$cache.XXXXXX") || return 0
    printf '%s\n' "$1" > "$staged" && mv "$staged" "$cache"
}

# Two calls: a single-use cookie, which iTerm2 can hand out instead, passes only the first.
accepted() {
    ITERM2_COOKIE="$1" "$it2" session get-status > /dev/null 2>&1 \
        && ITERM2_COOKIE="$1" "$it2" session get-status > /dev/null 2>&1
}

[ -n "${ITERM_SESSION_ID:-}" ] || skip
[ -f "$cache" ] && [ -x "$cc_status" ] || skip

# -a: BSD pgrep leaves out its own ancestors by default, and iTerm2 is one of the hook's.
iterm_pid=$(pgrep -a -x -U "$(id -u)" iTerm2 | head -n 1)
[ -n "$iterm_pid" ] || skip
# LC_ALL=C: lstart is localised, and the id has to match whatever locale a hook runs under.
iterm_id="$iterm_pid@$(LC_ALL=C ps -o lstart= -p "$iterm_pid" | tr -s ' ' '_')"

# it2 sits next to the binary the installer's cc-status link points at.
target=$(readlink "$cc_status" || printf '%s' "$cc_status")
case $target in
    /*) ;;
    *) target="$dir/$target" ;;
esac
it2="$(dirname "$target")/it2"
unset ITERM2_KEY

cached_id=
cookie=
read -r cached_id cookie < "$cache"

# 1. A cookie issued by the running iTerm2 goes straight to cc-status, payload on stdin. Once an
#    hour a detached probe drops it if iTerm2 refuses it now.
if [ "$cached_id" = "$iterm_id" ] && [ -n "$cookie" ]; then
    probed="$cache.probed"
    if [ -z "$(find "$probed" -mmin -60 2> /dev/null)" ]; then
        touch "$probed"
        (
            accepted "$cookie" && exit 0
            read -r current_id current_cookie < "$cache"
            [ "$current_cookie" = "$cookie" ] && write_cache ""
        ) < /dev/null > /dev/null 2>&1 &
    fi
    export ITERM2_COOKIE="$cookie"
    exec "$cc_status"
fi

cat > /dev/null

# 2. One request per iTerm2 process per hour. Locks of earlier processes go; an expired one is
#    renamed before removal, so two hooks that both saw it expire cannot remove a fresh lock.
lock="$cache.lock-$iterm_pid"
for old in "$cache".lock-*; do
    [ -d "$old" ] && [ "$old" != "$lock" ] && rmdir "$old" 2> /dev/null
done
if [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2> /dev/null)" ]; then
    mv "$lock" "$lock.dead.$$" 2> /dev/null && rmdir "$lock.dead.$$"
fi
mkdir "$lock" 2> /dev/null || exit 0

# 3. Detached: the announcement waits on the user, for up to the hour the lock lasts. The session
#    id is passed only when it is a plain token, since it is spliced into the script.
request='request cookie and key for app named "it2" reusable true'
case $ITERM_SESSION_ID in
    *[!A-Za-z0-9:-]*) ;;
    *) request="$request session id \"$ITERM_SESSION_ID\"" ;;
esac
(
    umask 077
    reply=$(osascript \
        -e 'with timeout of 3600 seconds' \
        -e "if application \"iTerm2\" is running then tell application \"iTerm2\" to $request" \
        -e 'end timeout') || exit 0
    fresh=${reply%% *}
    case $fresh in
        '' | *[!0-9A-Za-z]*) exit 0 ;;
    esac
    accepted "$fresh" && write_cache "$iterm_id $fresh"
) < /dev/null > /dev/null 2>&1 &

exit 0
