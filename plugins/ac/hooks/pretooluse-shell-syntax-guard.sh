#!/bin/sh
# PreToolUse Bash guard, every session: deny the zsh-only expansions Claude Code's bash parser cannot read,
# before they reach a permission prompt nobody is there to answer.
#
# Why. The Bash tool checks each command with a bash grammar. When the parse ends in an ERROR node it cannot rule
# out a hidden `rm`, and it asks: "Dangerous rm operation not ruled out, the shell may read this command
# differently than it was parsed". That decision is a safety check (`classifierApprovable: false`,
# `circuitBreaker: "dangerousRemoval"`), so bypassPermissions does not skip it, and an unattended session sits on
# the prompt until morning. Seen on 2026-10-27 from an ac:explore run that wrote `for k in ${(f)en_keys}`; the
# Bash tool runs the user's shell, zsh here, so the model reaches for zsh syntax.
# CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS did not lift it in a headless test on 2.1.311. A deny raises
# no prompt: the model reads the reason and rewrites.
#
# What it denies, measured on 2.1.311 with one Bash call per form:
#   a. `${(flags)name}`, a parameter expansion flag, unquoted, inside double quotes or inside backticks.
#   b. `${name[(flags)...]}`, a subscript flag: letters, optionally a delimited argument as in `(s:,:)`, then a
#      character that cannot continue an arithmetic subscript. `${a[(i+1)]}` and `${a[(i)*2]}` are bash
#      arithmetic and ran unprompted.
#   c. `${${...}}`, a nested expansion.
#   Each also after a `#` or `!` prefix: `${#a[(i)y]}`, `${!a[(i)y]}` and `${#${x}}` prompted too.
# Ran unprompted, so not denied: `${=x}`, `${~x}`, `${^x}`, `*(.)`, `=(cmd)`, `${x:u}`, `$((1+2))`, `${#x}`,
# `${a[@]}`, the unbraced `$a[(i)y]`. Single-quoted text, `$'...'`, a backslash-escaped `$` and a comment are not
# code and pass, as they did in the probe. A `$(...)` or a backtick span inside double quotes is code again, so
# its quotes are honoured.
#
# Precision beats recall: a false deny costs every session a rewrite. A heredoc body is text whose quoting this
# scan does not model, so the scan stops at the end of the line that opens one and the command passes. A `)` that
# closes a case pattern inside `$(...)` is read as closing the substitution; a single-quoted `${(` after it, still
# inside double quotes, is then denied. Rare enough to leave. Anything without jq or perl, or a payload that does
# not parse, passes. The command travels to perl as an argument, never inside its code.

set -u

# 0. Read the command; without jq or perl, or without a Bash command, there is nothing to judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v perl >/dev/null 2>&1 || exit 0
cmd="$(printf '%s' "$input" | jq -r 'select(.tool_name == "Bash") | .tool_input.command // empty' 2>/dev/null)" \
    || exit 0
[ -n "$cmd" ] || exit 0

# 1. Scan the command as code. Frames: top level, a double-quoted span, a `$(...)` substitution, a backtick span.
#    A match prints the construct and exits 0; a clean scan exits 1.
construct="$(perl -e '
    my $s = shift // "";
    my $n = length $s;
    my $i = 0;
    my $heredoc = 0;
    my @frames = (["top", 0]);
    my ($sq, $dq, $bs, $bt) = (chr(39), chr(34), chr(92), chr(96));
    my $zsh = qr{\A\$\{[#!]?(?:\(|\$\{|[A-Za-z_]\w*\[\([A-Za-z]+(?:(.).*?\g{-1})?\)[^\]\s+\-*/%<>&|^)])};

    while ($i < $n) {
        my $frame = $frames[-1];
        my $kind = $frame->[0];
        my $c = substr($s, $i, 1);

        exit 1 if $heredoc && $c eq "\n";

        if ($c eq $bs) {
            $i += 2;
            next;
        }

        if ($c eq "\$" && substr($s, $i) =~ $zsh) {
            my $close = index($s, "}", $i);
            my $span = $close < 0 || $close - $i >= 40 ? 40 : $close - $i + 1;
            print substr($s, $i, $span);
            exit 0;
        }

        if (substr($s, $i, 2) eq "\$(") {
            push @frames, ["sub", 0];
            $i += 2;
            next;
        }

        if ($c eq $bt) {
            if ($kind eq "bq") {
                pop @frames;
            } else {
                push @frames, ["bq", 0];
            }
            $i++;
            next;
        }

        if ($kind eq "dq") {
            pop @frames if $c eq $dq;
            $i++;
            next;
        }

        if ($c eq "\$" && substr($s, $i + 1, 1) eq $sq) {
            $i += 2;
            while ($i < $n) {
                my $d = substr($s, $i, 1);
                $i += $d eq $bs ? 2 : 1;
                last if $d eq $sq;
            }
            next;
        }

        if ($c eq $sq) {
            my $end = index($s, $sq, $i + 1);
            last if $end < 0;
            $i = $end + 1;
            next;
        }

        if (substr($s, $i, 3) eq "<<<") {
            $i += 3;
            next;
        }

        if (substr($s, $i) =~ /\A<<-?\s*[A-Za-z_\x22\x27\x5c]/) {
            $heredoc = 1;
            $i += 2;
            next;
        }

        if ($c eq $dq) {
            push @frames, ["dq", 0];
        } elsif ($c eq "#" && ($i == 0 || substr($s, $i - 1, 1) =~ /[\s;&|()<>]/)) {
            my $end = index($s, "\n", $i);
            last if $end < 0;
            $i = $end;
            next;
        } elsif ($kind eq "sub" && $c eq "(") {
            $frame->[1]++;
        } elsif ($kind eq "sub" && $c eq ")") {
            if ($frame->[1] == 0) {
                pop @frames;
            } else {
                $frame->[1]--;
            }
        }

        $i++;
    }

    exit 1;
' "$cmd" 2>/dev/null)" || exit 0

# 2. Deny with the construct and a rewrite both shells read alike, so the retry is one step.
jq -n --arg construct "$construct" '{
    hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: (
            "This command uses zsh-only expansion syntax (`" + $construct + "`). The Bash tool checks commands"
            + " with a bash parser, which cannot read it, so Claude Code would stop at a permission prompt that"
            + " bypass mode does not skip. Rewrite it in syntax bash and zsh read alike, since the command still"
            + " runs in the user shell (often zsh): loop over lines with"
            + " `printf \"%s\\n\" \"$var\" | while IFS= read -r line; do ...; done` instead of `${(f)var}`,"
            + " use `tr` for a case change, and an intermediate variable instead of `${${...}}` or a subscript"
            + " flag. Avoid bash-only forms such as `${var^^}` and `mapfile`, and quote `\"$var\"`, because zsh"
            + " does not word-split an unquoted variable. Or use the Grep and Glob tools, or write the logic to a"
            + " script file and run that."
        )
    }
}'
