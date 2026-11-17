# Sourced by the Stop guards: ac_wake_count <strict|loose> <payload> prints how many in-flight tasks
# will wake this session (lib/wake-count.jq decides), and returns non-zero when it cannot tell.
#
# The payload describes a Monitor exactly like a background Bash (type "shell", its command, no
# timeout), so strict mode alone left out every Monitor running an `until` or `while` loop and blocked
# 55 of 78 run-guard stops over 13 days on a wait the model had armed; it then polled in the
# foreground. A Monitor always expires (`timeoutMs`, which Claude Code 2.1.318 caps at 30 minutes; the
# check allows up to an hour) unless `persistent`, and its
# tool result in the transcript records both against its task id. In strict mode, when nothing else
# counts and a shell task is running, those ids are passed to the jq as `monitors`, and a shell task
# whose id is among them counts. The transcript is read only then, through fixed-string prefilters.

ac_wake_count() {
    _acw_mode="$1"
    _acw_payload="$2"
    _acw_jq="$(dirname "$0")/lib/wake-count.jq"

    _acw_n="$(printf '%s' "$_acw_payload" | jq -r --arg mode "$_acw_mode" -f "$_acw_jq" 2>/dev/null)" || return 1
    case "$_acw_n" in '' | *[!0-9]*) return 1 ;; esac

    if [ "$_acw_mode" = "strict" ] && [ "$_acw_n" -eq 0 ] \
        && printf '%s' "$_acw_payload" | jq -e 'any(.background_tasks[]?; .type == "shell")' >/dev/null 2>&1; then
        _acw_transcript="$(printf '%s' "$_acw_payload" | jq -r '.transcript_path // empty' 2>/dev/null)"
        if [ -n "$_acw_transcript" ] && [ -r "$_acw_transcript" ]; then
            # rg reads a cold 400 MB transcript in well under a second; BSD grep took over three.
            if command -v rg >/dev/null 2>&1; then _acw_grep="rg -aF --no-filename"; else _acw_grep="grep -aF"; fi
            _acw_monitors="$($_acw_grep '"timeoutMs"' "$_acw_transcript" 2>/dev/null | $_acw_grep '"taskId"' \
                | jq -cnR '[inputs | fromjson? | .toolUseResult? | objects
                    | select((.taskId | type) == "string" and .persistent != true
                        and (.timeoutMs | type) == "number" and .timeoutMs > 0 and .timeoutMs <= 3600000)
                    | .taskId]' 2>/dev/null)"
            case "$_acw_monitors" in
                '[]' | '') ;;
                *)
                    _acw_n="$(printf '%s' "$_acw_payload" | jq -r --arg mode strict \
                        --argjson monitors "$_acw_monitors" -f "$_acw_jq" 2>/dev/null)" || return 1
                    case "$_acw_n" in '' | *[!0-9]*) return 1 ;; esac
                    ;;
            esac
        fi
    fi

    printf '%s' "$_acw_n"
}
