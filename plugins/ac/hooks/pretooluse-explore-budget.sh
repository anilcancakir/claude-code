#!/bin/sh
# Call budget and read-only guard for ac:explore.
#
# Denies further tool calls once one explore spawn has made more than the budget, and tells it
# to report what it already has. Before counting, it denies the two things a read-only search
# agent must never do and was seen doing on 2026-09-23 during an /ac:init-project discovery pass
# (Haiku, a fixture repository): opening a secret-shaped file (`Read .env`, twice, by two agents
# whose brief said "path only") and running the project's own tooling in write mode
# (`prettier --write src/api/users.js --check`, which rewrote two tracked files). Every other
# condition fails OPEN (exit 0, no output): a payload it cannot parse, a call from the main
# thread or from any other agent, a missing jq, an unwritable counter, and any parse uncertainty.
#
# Why a hook and not a sentence in the agent body. Measured on Haiku 4.5 across 309 real runs,
# ac:explore averaged 36.6 tool calls and peaked at 183, although its body then carried a
# pass-count and a word-count bound. Its sibling ac:librarian carried the same shape of
# instruction and landed inside its budget. Same author, same phrasing, different model: prose
# numbers bind on Sonnet and do not bind on Haiku, so the bound for this agent has to sit
# outside its token stream. On Haiku 5.5 (the `haiku` alias since Claude Code 2.1.293) explore
# still averaged 30.9 tool calls over 150 runs, measured 2026-10-12, so the hook stays.
#
# Why agent_type rather than the agent's own frontmatter. Two frontmatter mechanisms were tested
# on 2.1.259 and neither works: `maxTurns: 3` did not bind (61 turns observed), and a `hooks:`
# block in an agent's frontmatter never fired (0 invocations, 0 payloads). What does work is this:
# a plugin-level hook receives `agent_type` and `agent_id` when it fires inside a subagent, and
# receives neither on the main thread. Payload keys dumped from a live spawn on 2.1.259:
#   agent_type=ac:explore agent_id=a1124775fb6dfdb02   <- inside the subagent
#   (both keys absent, `effort` present instead)       <- main thread
#
# The value carries the plugin namespace. A gate written against a bare `explore` matches nothing
# and the hook exits at the scope check on every call, which is what it did until this was dumped.
# The bare form stays in the gate for an agent installed unprefixed under `.claude/agents/`.
#
# The budget is calibrated on the tail, not the mean. At 60 it never fires on a median run and
# cuts the 183-call outlier. It is a circuit breaker, not a target, and the agent is told to
# report rather than to stop dead, so a tripped budget still returns usable work.
#
# The write checks are quote-aware. Measured over one week to 2026-10-17, the guard denied about
# 160 read-only searches, and 86 of 99 sampled were a `>` inside a quoted pattern (`rg "=> Foo"`,
# `awk 'NR>=150'`, a regex `->view(`) read as a redirect or a `|` read as a command separator. The
# redirect and segment checks now run on the command with quoted spans blanked
# (lib/blank-quotes.sh, byte offsets kept), a redirect target is read from the raw command, and a
# scratch file under /tmp, $TMPDIR or /dev/null is allowed. `git tag` is denied only when it
# creates or deletes a tag; the list forms stay readable. The secret scan still reads raw words.

set -u

max_calls="${AC_EXPLORE_MAX_CALLS:-60}"
case "$max_calls" in
    '' | *[!0-9]*) max_calls=60 ;;
esac

# 0. Read the payload. jq is the only parser; without either we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Scope. This hook governs one agent and nothing else. A main-thread call carries no
#    agent_type at all, so the absence check below is what keeps the orchestrator unaffected.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
case "$agent_type" in
    ac:explore | explore) ;;
    *) exit 0 ;;
esac

agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)"
[ -n "$agent_id" ] || exit 0
case "$agent_id" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

deny() {
    jq -cn --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse",
      permissionDecision: "deny", permissionDecisionReason: $r}}'
    exit 0
}

# One list of secret shapes, used by every branch below, on a path's last segment. A template or a
# public half (.env.example, .pub, a .d.ts type file) is not a secret and stays readable.
is_secret() {
    case "${1##*/}" in
        *.example | *.sample | *.dist | *.template | *.pub | *.d.ts | *.schema) return 1 ;;
        .env | .env.* | *.pem | *.key | *.p12 | *.pfx | id_rsa | id_ed25519 | credentials*.json \
            | service-account*.json | auth.json) return 0 ;;
    esac
    return 1
}

# Succeeds when the command writes. $1 is the raw command, $2 the text to judge: the command with
# quoted spans blanked, or the raw command again for the stricter reading.
is_write() {
    # A redirect into a file, anywhere in the command; 2>/dev/null, >/dev/null and >&2 are the forms
    # explore uses constantly and write nothing, and so is a scratch file under a temp directory
    # (the hook's own expanded TMPDIR included, since a tool may print it expanded). `2>f`, `1>f` and
    # `&>f` redirect too; `2>&1` duplicates a descriptor and does not. Blanking keeps byte offsets:
    # the `>` is found in $2 and its target word is read from $1, quotes stripped, so a quoted
    # "$TMPDIR/a.log" is judged by its text. A target ends at `)` or a backtick so that the
    # `2>/dev/null` in `$(git log 2>/dev/null)` still reads as /dev/null.
    redirect="$(perl -e '
        my ($raw, $blank) = @ARGV;
        my $dirs = qr{/tmp|/private/tmp|\$TMPDIR|\$\{TMPDIR\}|\$\{TMPDIR:-/tmp\}};
        my $dir = $ENV{TMPDIR} // "";
        $dir =~ s!/+\z!!;
        $dirs = qr{$dirs|\Q$dir\E|\Q/private$dir\E} if $dir =~ m!^/.!;
        my $scratch = qr{^(?:/dev/null|(?:$dirs)/.+)$};
        while ($blank =~ /(?<!>)(?:&|\d*)>>?\s*(?!&)(?=\S)/g) {
            my $start = $+[0];
            $blank =~ /\G[^\s;|&<>)\x60]*/gc;
            my $target = substr($raw, $start, $+[0] - $start);
            $target =~ tr/"\x27//d;
            next if $target =~ $scratch && $target !~ m{(?:^|/)\.\.(?:/|$)};
            print "deny";
            last;
        }
    ' -- "$1" "$2" 2>/dev/null)"
    [ "$redirect" = "deny" ] && return 0
    printf '%s\n' "$2" | tr ';|&\n' '\n\n\n\n' | sed -e 's/^[[:space:]]*//' -e 's/^\([A-Za-z_][A-Za-z0-9_]*=[^ ]* \)*//' \
    | rg --no-config -q --pcre2 -e \
'^(\S*/)?(npx\s+|bunx\s+|pnpm\s+exec\s+|yarn\s+)?(prettier|biome)\b.*\s(--write|-w)\b'\
'|^(\S*/)?(npx\s+)?eslint\b.*\s--fix\b'\
'|^(\S*/)?ruff\s+(format\b(?!.*--(check|diff))|check\b.*--fix)'\
'|^(\S*/)?black\b(?!.*--(check|diff|version|help))'\
'|^(\S*/)?(gofmt\b.*\s-w\b|go\s+(fmt|get|mod\s+tidy)\b|rustfmt\b(?!.*--(check|version)))'\
'|^(\S*/)?cargo\s+(fmt|add|remove|install|update|fix)\b'\
'|^(\S*/)?dart\s+(format|fix)\b(?!.*(--output[= ]none|--dry-run|--set-exit-if-changed|--version))'\
'|^(\S*/)?(dart|flutter)\s+pub\s+(get|add|remove|upgrade|downgrade)\b'\
'|^(\S*/)?pint\b(?!.*(--test|--version|--help))|^(\S*/)?php-cs-fixer\s+fix\b(?!.*--dry-run)'\
'|^(\S*/)?(php\s+)?artisan\s+(?!(list|about|route:list|--version|help)\b)\S'\
'|^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|update|upgrade|up)\b|^yarn\s*$'\
'|^(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fix|lint:fix|format:write)\b|^(npm|pnpm|yarn|bun)\b.*\s--\s.*--fix\b'\
'|^(composer\s+(install|update|require|remove)|pip3?\s+install|gem\s+install|bundle(\s+install)?\s*$)\b'\
'|^git\b(\s+-C\s+\S+)?\s+(checkout|switch|reset|clean|commit|push|rebase|merge|restore|apply|cherry-pick|am|rm|mv|branch\s+-[dDmM])(?![-\w])'\
'|^git\b(\s+-C\s+\S+)?\s+tag(?![-\w])(?!\s*$|\s+(-l|--list|-n\d*|--contains|--points-at|--merged|--no-merged|--sort)(\s|=|$))'\
'|^git\b(\s+-C\s+\S+)?\s+tag(?![-\w]).*\s(-[adsfmu]+|--delete|--annotate|--sign|--force)(\s|$)'\
'|^git\b(\s+-C\s+\S+)?\s+stash(?!\s+(list|show))(?![-\w])'\
'|^(rm|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|tee)\b|^sed\b.*\s-i|^perl\b.*\s-\w*i'\
'|^xargs\b.*\b(rm|mv)\b|^find\b.*\s(-delete|-exec\s+(rm|mv))\b' 2>/dev/null
}

# 1b. Read-only guard. A secret-shaped file is reported by path, never opened. The project's own
#     tooling never runs in a mode that writes, and nothing installs, moves, deletes or rewrites git
#     state. Each Bash check runs per simple command, anchored at the command word, so a search that
#     merely mentions a tool (`rg -n pint composer.json`) is not mistaken for running it.
secret_reason="ac:explore does not open secret-shaped files. Report the path only (it exists, it is or is not tracked), and continue with the rest of the search."
write_reason="ac:explore is read-only: it does not run formatters or fixers in write mode, install packages, write files, or change git state. Read the tool's config and the manifest instead (a --version check is fine), note the command in your report for the orchestrator, and continue."
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"
case "$tool_name" in
    Read)
        is_secret "$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" \
            && deny "$secret_reason" ;;
    Grep)
        is_secret "$(printf '%s' "$input" | jq -r '.tool_input.path // empty' 2>/dev/null)" \
            && deny "$secret_reason" ;;
    Bash)
        cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
        [ -n "$cmd" ] || exit 0
        set -f  # the word loops below split the command unquoted; a `*.js` must not glob
        # Secret read: any word of a simple command, split on whitespace, quotes and shell
        # punctuation (so `cat ".env"`, `git show HEAD:.env` and `jq . credentials.json` all surface
        # the path), unless that simple command only asks whether the file exists or is tracked.
        # A redirect or command substitution carries no such exemption.
        segments="$(printf '%s\n' "$cmd" | tr ';|&' '\n\n\n')"
        old_ifs="$IFS"; IFS='
'
        for seg in $segments; do
            IFS="$old_ifs"
            seg="$(printf '%s' "$seg" | sed -e 's/^[[:space:]]*//')"
            case "$seg" in
                *'>'* | *'<'* | *'$('* | *'`'*) ;;
                test\ * | '[ '* | ls\ * | stat\ * | 'git check-ignore '* | 'git ls-files'* | 'git status'* | echo\ *) continue ;;
            esac
            for word in $(printf '%s\n' "$seg" | tr '"`()<>=:,\t'"'" '           '); do
                is_secret "$word" && deny "$secret_reason"
            done
        done
        IFS="$old_ifs"
        # The write checks judge the command with quoted spans blanked, so a `>` or `|` inside a
        # search pattern is not a redirect or a separator. No blanker or no perl: cannot judge.
        blanked=""
        if [ -r "$(dirname "$0")/lib/blank-quotes.sh" ]; then
            . "$(dirname "$0")/lib/blank-quotes.sh"
            blanked="$(ac_blank_quotes "$cmd")" || blanked=""
        fi
        if ! command -v rg >/dev/null 2>&1; then
            printf '%s\n' "ac explore guard: ripgrep (rg) not found; write checks inactive." >&2
        elif [ -n "$blanked" ]; then
            is_write "$cmd" "$blanked" && deny "$write_reason"
            # A command interpreter's payload is quoted (`sh -c "echo x > f"`, `perl -e "open F, q(>x)"`),
            # so blanking hides exactly the text it runs. For those calls the raw command is judged as
            # well, the old stricter reading, at the price of a false deny on a quoted `>` inside the
            # payload. A command word also counts right after `$(`, `(` or a backtick.
            if printf '%s\n' "$blanked" | tr ';|&\n' '\n\n\n\n' | sed -e 's/^[[:space:]]*//' \
                | rg --no-config -q --pcre2 -e \
'(?:^|[(`])\s*(?:\S*/)?(?:(?:sh|bash|zsh|dash|ksh|eval)(?![\w-])|(?:perl|python3?|node|ruby)\s+(?:-\S+\s+)*-[A-Za-z]*[ecE]\b)' 2>/dev/null; then
                is_write "$cmd" "$cmd" && deny "$write_reason"
            fi
        fi
        ;;
esac

# 2. Keep the counter under TMPDIR, keyed by the agent id, which is unique per spawn. It used to
#    live in the target project's .ac/state/, which left an untracked, unignored .ac/ directory in
#    every repository an explore ran in, including ones that never used ac and a `/ac:init-project
#    --dry-run` that promised to write nothing (seen 2026-09-23).
dir="${TMPDIR:-/tmp}/ac-agent-budget"
[ -L "$dir" ] && exit 0
mkdir -p "$dir" 2>/dev/null || exit 0
[ -O "$dir" ] || exit 0

# 3. Sweep counters older than a day. Self-cleaning, because nothing else deletes these and a
#    counter file per spawn would otherwise accumulate one per explore forever. The plan guard's
#    own counter has exactly that problem today.
find "$dir" -type f -name '*.json' -mtime +1 -delete 2>/dev/null

counter="$dir/$agent_id.json"
calls=0
if [ -f "$counter" ] && jq -e . "$counter" >/dev/null 2>&1; then
    calls="$(jq -r '.calls // 0' "$counter" 2>/dev/null)"
    case "$calls" in '' | *[!0-9]*) calls=0 ;; esac
fi

# 4. Over budget. Deny and say what to do instead. Denying without a next action turns a
#    circuit breaker into a dead end, and the caller gets nothing rather than partial findings.
if [ "$calls" -ge "$max_calls" ]; then
    reason="Call budget reached for this explore spawn: $calls of $max_calls tool calls.

Report the findings you already have. Cite each one as file_path:line_number, and under Notes
name the angle you did not finish and the query you would have run next, so the orchestrator can
brief that angle separately rather than guessing what is missing.

Returning partial findings with the gap named is the expected outcome here, not a failure. An
empty report is the failure."
    jq -cn --arg r "$reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $r
      }
    }'
    exit 0
fi

# 5. Under budget. Count and allow. A counter we cannot persist would restart the count from
#    zero on the next call and never reach the budget, so failing open here is the honest
#    direction: the run continues unbounded rather than being denied on a bookkeeping error.
calls=$((calls + 1))
tmp="$counter.tmp.$$"
if jq -cn --argjson c "$calls" '{calls: $c}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$counter" 2>/dev/null
else
    rm -f "$tmp" 2>/dev/null
fi
exit 0
