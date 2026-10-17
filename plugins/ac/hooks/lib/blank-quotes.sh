# Quote blanker, sourced by the hooks that test a Bash command for redirects and command separators.
#
# `ac_blank_quotes "$cmd"` prints the command with every byte inside a single-quoted span, a
# double-quoted span (backslash escapes honoured) and a `$'...'` span replaced by `_`, keeping the
# quote characters and everything outside quotes. The output has the input's byte length, so a caller
# can map an offset in the blanked text back to the raw command. An unterminated quote blanks to the
# end.
#
# Inside a double-quoted span a `$(...)` command substitution and a backtick span run as commands, so
# they pass through unblanked (quotes nested in them are blanked in turn): `echo "$(git log > f)"`
# keeps its redirect visible. Without that the guards read a write hidden in a substitution as quoted
# text, which the earlier raw-text checks did not (found in review, 2026-10-17).
#
# One left-to-right scan rather than a chain of regex substitutions: wake-count.jq:81-82 blanks
# single quotes first, so a `'` inside double quotes (`echo "it's" > out`) pairs with a later one and
# swallows the redirect. Here the state decides what a quote means. A backslash outside quotes
# escapes the next byte, so `\'` and `\"` open nothing.
#
# The command travels as an argument, never inside the perl code, so its content cannot run. Perl
# runs without `use utf8`, which keeps length and substr in bytes. A host without perl prints nothing
# and returns non-zero, which callers read as "cannot judge" and fail open.
#
# Plain sh, no bash-only syntax: the scripts that source this run under `#!/bin/sh`.

ac_blank_quotes() {
  perl -e '
    my $s = shift // "";
    my ($sq, $dq, $bs, $dollar, $bt) = (chr(39), chr(34), chr(92), chr(36), chr(96));
    my ($out, $i, $n) = ("", 0, length $s);

    # Unquoted text, copied as is. $term is undef at the top level, ")" inside a command
    # substitution (parentheses balanced) and a backtick inside a backtick span; the terminator is
    # copied too and ends the call. A quote met here opens a blanked span.
    sub code {
      my ($term) = @_;
      my $depth = 0;

      while ($i < $n) {
        my $c = substr($s, $i, 1);

        if ($c eq $bs) {
          $out .= substr($s, $i, 2);
          $i += 2;
          next;
        }

        if (defined $term) {
          if ($c eq $term && $depth == 0) {
            $out .= $c;
            $i += 1;
            return;
          }
          if ($term eq ")") {
            $depth++ if $c eq "(";
            $depth-- if $c eq ")";
          }
        }

        if ($c eq $sq) {
          $out .= $c;
          $i += 1;
          blank_until($sq, 0);
        } elsif ($c eq $dq) {
          $out .= $c;
          $i += 1;
          blank_double();
        } elsif ($c eq $dollar && substr($s, $i + 1, 1) eq $sq) {
          $out .= $c . $sq;
          $i += 2;
          blank_until($sq, 1);
        } else {
          $out .= $c;
          $i += 1;
        }
      }
    }

    # A backslash is literal inside plain single quotes and escapes inside the other two.
    sub blank_until {
      my ($close, $escapes) = @_;

      while ($i < $n) {
        my $d = substr($s, $i, 1);
        if ($d eq $close) {
          $out .= $d;
          $i += 1;
          return;
        }
        if ($escapes && $d eq $bs) {
          $out .= "_" x length(substr($s, $i, 2));
          $i += 2;
          next;
        }
        $out .= "_";
        $i += 1;
      }
    }

    # A double-quoted span runs commands: the shell executes a command substitution and a backtick
    # span inside it, so their text is judged as unquoted. An escaped dollar or backtick is not one.
    sub blank_double {
      while ($i < $n) {
        my $d = substr($s, $i, 1);
        if ($d eq $dq) {
          $out .= $d;
          $i += 1;
          return;
        }
        if ($d eq $bs) {
          $out .= "_" x length(substr($s, $i, 2));
          $i += 2;
        } elsif ($d eq $dollar && substr($s, $i + 1, 1) eq "(") {
          $out .= $d . "(";
          $i += 2;
          code(")");
        } elsif ($d eq $bt) {
          $out .= $d;
          $i += 1;
          code($bt);
        } else {
          $out .= "_";
          $i += 1;
        }
      }
    }

    code(undef);
    print $out;
  ' -- "$1"
}
