# Quote blanker, sourced by the hooks that test a Bash command for redirects and command separators.
#
# `ac_blank_quotes "$cmd"` prints the command with every byte inside a single-quoted span, a
# double-quoted span (backslash escapes honoured) and a `$'...'` span replaced by `_`, keeping the
# quote characters and everything outside quotes. The output has the input's byte length, so a caller
# can map an offset in the blanked text back to the raw command. An unterminated quote blanks to the
# end.
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
    my ($sq, $dq, $bs, $dollar) = (chr(39), chr(34), chr(92), chr(36));
    my ($out, $i, $n) = ("", 0, length $s);

    while ($i < $n) {
      my $c = substr($s, $i, 1);

      if ($c eq $bs) {
        $out .= substr($s, $i, 2);
        $i += 2;
        next;
      }

      my ($close, $escapes);
      if ($c eq $sq) {
        ($close, $escapes) = ($sq, 0);
        $out .= $c;
        $i += 1;
      } elsif ($c eq $dq) {
        ($close, $escapes) = ($dq, 1);
        $out .= $c;
        $i += 1;
      } elsif ($c eq $dollar && substr($s, $i + 1, 1) eq $sq) {
        ($close, $escapes) = ($sq, 1);
        $out .= $c . $sq;
        $i += 2;
      } else {
        $out .= $c;
        $i += 1;
        next;
      }

      # A backslash is literal inside plain single quotes and escapes inside the other two.
      while ($i < $n) {
        my $d = substr($s, $i, 1);
        if ($d eq $close) {
          $out .= $d;
          $i += 1;
          last;
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

    print $out;
  ' -- "$1"
}
