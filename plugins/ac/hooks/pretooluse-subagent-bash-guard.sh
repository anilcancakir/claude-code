#!/bin/sh
# PreToolUse Bash guard for ac subagents: deny an unbounded search up front and hand back the
# recipe that finishes.
#
# Why. The Claude Code Bash tool moves a command that outlives its timeout to the background, and a
# subagent that started one parks after its final report until that shell ends. Measured over the
# last week across all projects (2026-10-17): about 107 Bash timeouts. The clusters were recursive
# search 23 (explore 7, junior-high 6), binary grep 21 (oracle 10, librarian 4), a `find` rooted at
# `/` or the home directory 10, and a transcript grep 4. The commands that timed out:
#   find / -name 'check_holes.py' -not -path '*/proc/*' 2>/dev/null | head
#   grep -rl "4f11fdad-acdc" ~/.claude/projects
#   B=~/.local/share/claude/versions/2.1.301; LC_ALL=C grep -a -o -E '.{0,255}X.{0,255}' $B
#   strings "$B" | grep -oE ...
# Each has a bounded form (a named directory, the Glob or Grep tool, the search-history tool, an mmap
# window), so the deny carries that form: a refusal alone would send the agent to retry the same
# search in a new spelling.
#
# What it denies, for ac agents only (`ac:<name>`, or one of the thirteen bare names for an agent
# installed unprefixed):
#   a. `find`, recursive `grep`, `rg` or `fd` whose search root is `/` or the home directory, unless
#      `-maxdepth` (find) or `--max-depth`/`-d` (rg, fd) limits the walk to 2 levels or fewer.
#   b. recursive `grep`, `rg`, or `cat` of a directory, over ~/.claude/projects itself or one project
#      directory under it. A regular file there (one transcript, memory/MEMORY.md) is a bounded read.
#   c. `strings`, or `grep`/`rg` in text mode (-a, --text, --binary-files=text), on a regular file
#      over 100 MiB.
#   d. recursive `grep` from a repository root (a directory holding `.git`, the cwd when no path is
#      given): grep ignores .gitignore, which is how `grep -ril x .` over a 44 GB repository ran for
#      31 minutes. `rg` and the Grep tool honour it, so the deny points there.
#   e. for the four plan workers, general-purpose and the main thread (they hold the Edit tool), a small in-place replace through the
#      shell: `sed -i` or `perl -i` with exactly one file operand, or an inline python script that
#      calls `.replace(` and writes (at most 3 write calls). Since 2026-10-01 the workers made about 7k
#      such edits against 17k Edit calls, and each one skipped the diff, Claude Code's stale-write check
#      and every hook matched on Edit|Write. A command that starts with `find`, `xargs`, `for`, `while`
#      or `until`, or carries `-exec`, `git ls-files`, `git grep -l`, a glob or a directory walk, marks a
#      rewrite across many files and passes. The deny fires once per command:
#      a marker under ${TMPDIR:-/tmp}/ac-bash-edit-guard/, keyed on session id and the command's cksum,
#      lets the identical command through the second time. AC_BASH_EDIT_GUARD=0 turns this rule off.
#
# How it reads the command. Command words and separators are found on the quote-blanked text
# (lib/blank-quotes.sh), so `rg -n "find / -name" docs` is a search for a string and not a root
# find. Operands are read from the raw command at the same offsets, relative paths resolve against
# the payload cwd (not once the command changes directory), and the only expansions it performs are
# `~`, `$HOME` and a variable assigned earlier in the same command. Precision beats recall: a false
# deny blocks every ac agent, so an operand it cannot resolve, a missing perl, an unreadable size or
# any other doubt fails OPEN (exit 0, no output). The main thread and every other agent are never
# touched.

set -u

# shellcheck source=lib/blank-quotes.sh
[ -r "$(dirname "$0")/lib/blank-quotes.sh" ] || exit 0
. "$(dirname "$0")/lib/blank-quotes.sh"
# shellcheck source=lib/ac-agent-scope.sh
[ -r "$(dirname "$0")/lib/ac-agent-scope.sh" ] || exit 0
. "$(dirname "$0")/lib/ac-agent-scope.sh"

max_bytes=104857600

# 0. Read the payload. jq is the only parser; without it we cannot judge, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# 1. Scope. The search rules (a to d) judge ac subagents only: a main-thread call carries no agent_type,
#    which leaves the orchestrator alone. The shell-edit rule (e) also covers the main thread and
#    general-purpose, the two callers that hold the Edit tool and made most of the shell edits.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
in_scope=0
ac_agent_in_scope "$agent_type" && in_scope=1
edit_scope=0
case "$agent_type" in
    '' | general-purpose) edit_scope=1 ;;
esac
[ "$in_scope" = 1 ] || [ "$edit_scope" = 1 ] || exit 0

# Oracle, librarian, plan-reviewer and plan-code-review inherit the MCP search-history tool through a
# denylist, while the other agents are allowlisted without it, so only these four are pointed at it.
case "$agent_type" in
    oracle | ac:oracle | librarian | ac:librarian | plan-reviewer | ac:plan-reviewer \
        | plan-code-review | ac:plan-code-review) history=1 ;;
    *) history=0 ;;
esac

case "$agent_type" in
    plan-worker-quick | ac:plan-worker-quick | plan-worker-junior | ac:plan-worker-junior \
        | plan-worker-junior-high | ac:plan-worker-junior-high | plan-worker-senior | ac:plan-worker-senior) worker=1 ;;
    *) worker=0 ;;
esac
[ "$worker" = 1 ] && edit_scope=1
session_id="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0
# A caller outside the ac agents is judged for shell edits only, so most commands end here, before perl starts.
if [ "$in_scope" = 0 ]; then
    case "$cmd" in
        *sed* | *perl* | *python*) ;;
        *) exit 0 ;;
    esac
fi
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"

# 2. Locate the offending operands. The perl below prints one `KIND<TAB>command<TAB>path` line per
#    candidate (ROOT, TRANSCRIPT, BIG) and nothing when there is none. The size test stays in sh.
blanked="$(ac_blank_quotes "$cmd")" || exit 0
[ -n "$blanked" ] || exit 0

# No single quote may appear in this body: it is a single-quoted shell string.
scan_src='
  my ($raw, $blank, $home, $cwd) = @ARGV;
  exit 0 unless defined $raw && defined $blank && length($raw) == length($blank);
  $home = "" unless defined $home;
  $cwd = "" unless defined $cwd;

  sub norm {
    my @out;
    for my $s (split m{/+}, shift) {
      next if $s eq "" || $s eq ".";
      if ($s eq "..") { pop @out; next; }
      push @out, $s;
    }
    return "/" . join("/", @out);
  }
  $home = $home =~ m{^/} ? norm($home) : "";
  $cwd = "" unless $cwd =~ m{^/};
  my $projects = $home ne "" ? "$home/.claude/projects" : "";
  my $has_cd = $blank =~ m{(?:^|[\s;&|(`])(?:cd|pushd|popd)(?:[\s;]|$)} ? 1 : 0;
  my %vars;

  # The operand as the shell would hand it over, or undef when that cannot be known for certain.
  sub resolve {
    my ($r, $b) = @_;
    return undef if $r =~ /[`\\]|\$\(/;
    my $quoted = 0;
    if ($b =~ /^(["\x27])_*\1$/) {
      $r = substr($r, 1, length($r) - 2);
      $quoted = 1;
    } elsif ($b =~ /["\x27]/) {
      return undef;
    }
    return undef if $r eq "" || $r =~ /[\n\t\r]/;
    if (!$quoted && $r =~ m{^~(?:/|$)}) {
      return undef if $home eq "";
      $r = $home . substr($r, 1);
    }
    my $bad = 0;
    $r =~ s{\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)}{
      my $name = defined $1 ? $1 : $2;
      my $v = $name eq "HOME" ? ($home ne "" ? $home : undef) : $vars{$name};
      defined $v ? $v : do { $bad = 1; "" };
    }ge;
    return undef if $bad || $r =~ /\$/ || $r =~ /[*?\[\]{}]/;
    return norm($r) if $r =~ m{^/};
    return undef if $has_cd || $cwd eq "";
    return norm("$cwd/$r");
  }

  sub is_root { my $p = shift; return $p eq "/" || ($home ne "" && $p eq $home); }
  # Only the projects directory itself or one project directory under it holds every transcript or a
  # whole project of them; a file or a deeper directory (memory/, one .jsonl) is a bounded read.
  sub near_projects {
    my $p = shift;
    return 0 if $projects eq "";
    return 1 if $p eq $projects;
    return 0 unless index($p, "$projects/") == 0;
    my @below = split m{/}, substr($p, length($projects) + 1);
    return @below == 1 ? 1 : 0;
  }
  # A find or rg depth limit of 2 or less keeps the walk off the tree; the largest stated limit counts.
  sub shallow {
    my $max;
    for (@_) { $max = $_ if /^\d+$/ && (!defined $max || $_ > $max); }
    return defined $max && $max <= 2;
  }

  my %short = (grep => "efmABCdD", rg => "efgtTABCmMjEdr", fd => "etEdxXcjSo", strings => "ntTe", cat => "");
  my %long = (
    grep => [qw(regexp file max-count after-context before-context context directories devices include
                exclude exclude-dir exclude-from label binary-files)],
    rg => [qw(regexp file glob iglob type type-not type-add max-count max-depth maxdepth max-filesize replace
              context after-context before-context threads sort sortr colors pre pre-glob engine encoding
              path-separator ignore-file dfa-size-limit regex-size-limit binary-files)],
    fd => [qw(extension exclude type max-depth min-depth color threads size owner search-path base-directory
              changed-within changed-before exec exec-batch)],
    strings => [qw(bytes radix target encoding)],
    cat => [],
  );

  sub parse {
    my ($kind, $args) = @_;
    my (%flag, %val, @pos);
    my %is_long = map { $_ => 1 } @{ $long{$kind} };
    my $done = 0;
    ARG: for (my $i = 0; $i < @$args; $i++) {
      my $b = $args->[$i]{b};
      my $r = $args->[$i]{r};
      if ($done || $b !~ /^-./) { push @pos, $args->[$i]; next; }
      if ($b eq "--") { $done = 1; next; }
      if ($b =~ /^--([A-Za-z][A-Za-z-]*)(=.*)?$/) {
        my ($name, $inline) = ($1, $2);
        $flag{$name} = 1;
        my $v;
        if (defined $inline) {
          $v = substr($r, length($name) + 3);
        } elsif ($is_long{$name} && $i + 1 < @$args) {
          $v = $args->[++$i]{r};
        }
        if (defined $v) {
          $v =~ s/^(["\x27])(.*)\1$/$2/s;
          push @{ $val{$name} }, $v;
        }
        last ARG if $kind eq "fd" && ($name eq "exec" || $name eq "exec-batch");
        next;
      }
      my @c = split //, substr($b, 1);
      for (my $j = 0; $j < @c; $j++) {
        $flag{$c[$j]} = 1;
        next unless index($short{$kind}, $c[$j]) >= 0;
        my $rest = join("", @c[$j + 1 .. $#c]);
        if ($rest eq "" && $i + 1 < @$args) { $rest = $args->[++$i]{r}; }
        push @{ $val{$c[$j]} }, $rest;
        last ARG if $kind eq "fd" && ($c[$j] eq "x" || $c[$j] eq "X");
        last;
      }
    }
    return { flag => \%flag, val => \%val, pos => \@pos };
  }

  # Rule e. Any sign of a rewrite across many files lets every shell edit in the command pass. Path
  # enumeration is read from the raw text on purpose, since a stray hit only allows; a loop or finder is a
  # command word of a segment (found below), so the word "find" or "for" in a comment or a PHP call is not one.
  my $bulk = $raw =~ m{os\.(?:walk|scandir)|\b(?:r?glob|listdir|iterdir)\s*\(|-exec\b|git\s+ls-files|git\s+grep\b[^\n;|&]*\s-[A-Za-z]*l} ? 1 : 0;

  # The one file a sed or perl edit writes, as written in the command, or undef when that is not
  # certain: no in-place flag, an unknown option, an operand count other than one, a glob or a variable.
  sub one_file {
    my $t = shift;
    my ($r, $b) = ($t->{r}, $t->{b});
    return undef if $r eq "" || $r =~ /[*?\[\]{}\$`\\]/;
    if ($b =~ /^(["\x27])_*\1$/) {
      $r = substr($r, 1, length($r) - 2);
    } elsif ($b =~ /["\x27]/) {
      return undef;
    }
    return $r eq "" ? undef : $r;
  }

  sub sed_target {
    my $args = shift;
    my ($inplace, $script, $done, @ops) = (0, 0, 0);
    for (my $i = 0; $i < @$args; $i++) {
      my $b = $args->[$i]{b};
      if ($done || $b !~ /^-./) { push @ops, $args->[$i]; next; }
      if ($b eq "--") { $done = 1; next; }
      if ($b =~ /^--([a-z-]+)(=.*)?$/) {
        my ($name, $inline) = ($1, $2);
        if ($name eq "in-place") { $inplace = 1; next; }
        if ($name eq "expression" || $name eq "file") { $script = 1; $i++ unless defined $inline; next; }
        if ($name eq "line-length") { $i++ unless defined $inline; next; }
        next if $name =~ /^(?:quiet|silent|regexp-extended|separate|null-data|zero-terminated|posix|debug|sandbox|follow-symlinks|unbuffered|binary)$/;
        return undef;
      }
      my @c = split //, substr($b, 1);
      for (my $j = 0; $j < @c; $j++) {
        my $ch = $c[$j];
        if ($ch eq "i" || $ch eq "I") {
          $inplace = 1;
          # BSD sed takes the backup suffix as its own word, and an empty one is written -i "".
          $i++ if $j == $#c && $i + 1 < @$args && $args->[$i + 1]{b} =~ /^(["\x27])\1$/;
          last;
        }
        if ($ch =~ /^[efl]$/) { $script = 1 if $ch ne "l"; $i++ if $j == $#c; last; }
        next if $ch =~ /^[nErsuz]$/;
        return undef;
      }
    }
    return undef unless $inplace;
    shift @ops unless $script;
    return @ops == 1 ? one_file($ops[0]) : undef;
  }

  sub perl_target {
    my $args = shift;
    my ($inplace, $script, $done, @ops) = (0, 0, 0);
    for (my $i = 0; $i < @$args; $i++) {
      my $b = $args->[$i]{b};
      # perl stops reading switches at the first word that is not one.
      if ($done || $b !~ /^-./) { push @ops, $args->[$i]; $done = 1; next; }
      if ($b eq "--") { $done = 1; next; }
      return undef if $b =~ /^--/;
      my @c = split //, substr($b, 1);
      for (my $j = 0; $j < @c; $j++) {
        my $ch = $c[$j];
        if ($ch eq "i") { $inplace = 1; last; }
        if ($ch eq "e" || $ch eq "E") { $script = 1; $i++ if $j == $#c; last; }
        if ($ch =~ /^[MmI]$/) { return undef if $j == $#c; last; }
        if ($ch eq "0" || $ch eq "l") { $j++ while $j + 1 < @c && $c[$j + 1] =~ /^[0-9]$/; next; }
        next if $ch =~ /^[pnawsStTUWXc]$/;
        return undef;
      }
    }
    return undef unless $inplace;
    shift @ops unless $script;
    return @ops == 1 ? one_file($ops[0]) : undef;
  }

  # An inline python script (heredoc, -c or piped) that replaces text and writes it back, with no more
  # write calls than a single-file edit needs. An analysis script, with no write, passes.
  sub python_edits {
    return 0 unless index($raw, ".replace(") >= 0;
    my $writes = () = $raw =~ /(?<!sys\.stdout)(?<!sys\.stderr)\.write(?:_text)?\(/g;
    my $open_w = $raw =~ /\bopen\([^()]*,\s*(?:mode\s*=\s*)?["\x27]w\+?["\x27]/ ? 1 : 0;
    return 0 unless $writes || $open_w;
    return $writes <= 3 ? 1 : 0;
  }

  my (@segs, @toks);
  my $start = -1;
  my $n = length $blank;
  for (my $i = 0; $i <= $n; $i++) {
    my $c = $i < $n ? substr($blank, $i, 1) : "\n";
    if ($c eq "\\" && $i < $n) {
      if (substr($blank, $i + 1, 1) eq "\n") {
        if ($start >= 0) { push @toks, [$start, $i]; $start = -1; }
        $i++;
        next;
      }
      $start = $i if $start < 0;
      $i++;
      next;
    }
    if ($c =~ /[ \t\r]/ || $c =~ /[;|&\n()`]/) {
      if ($start >= 0) { push @toks, [$start, $i]; $start = -1; }
      if ($c !~ /[ \t\r]/) { push @segs, [@toks]; @toks = (); }
      next;
    }
    # A word that opens with # is a comment to the end of the line, so its words are not operands.
    if ($c eq "#" && $start < 0) {
      $i++ while $i + 1 < $n && substr($blank, $i + 1, 1) ne "\n";
      next;
    }
    $start = $i if $start < 0;
  }

  my @found;
  my $reserved = qr/^(?:!|then|do|else|elif|if|while|until|time|command|exec|nohup|sudo|env|builtin)$/;

  # A segment that opens with a loop or a finder marks a rewrite across many files.
  for my $seg (@segs) {
    for my $t (@$seg) {
      my $w = substr($blank, $t->[0], $t->[1] - $t->[0]);
      next if $w =~ /^(?:!|do|then|else|elif|if|time|command|exec|nohup|sudo|env|builtin)$/ || $w =~ /^[A-Za-z_][A-Za-z0-9_]*=/ || $w =~ /^\d*[<>]/;
      $bulk = 1 if $w =~ /^(?:find|xargs|for|while|until|select)$/;
      last;
    }
  }

  for my $seg (@segs) {
    my @w;
    my @t = map { { b => substr($blank, $_->[0], $_->[1] - $_->[0]), r => substr($raw, $_->[0], $_->[1] - $_->[0]) } } @$seg;
    for (my $k = 0; $k < @t; $k++) {
      if ($t[$k]{b} =~ /^\d*[<>]/) {
        $k++ if $t[$k]{b} =~ /^\d*(?:>>?|<<?-?)$/;
        next;
      }
      push @w, $t[$k];
    }
    next unless @w;

    if (!grep { $_->{b} !~ /^[A-Za-z_][A-Za-z0-9_]*=/ } @w) {
      for my $t (@w) {
        $t->{b} =~ /^([A-Za-z_][A-Za-z0-9_]*)=/;
        my $name = $1;
        my $len = length($name) + 1;
        my $v = resolve(substr($t->{r}, $len), substr($t->{b}, $len));
        if (defined $v) { $vars{$name} = $v; } else { delete $vars{$name}; }
      }
      next;
    }

    my $k = 0;
    while ($k < @w) {
      my $b = $w[$k]{b};
      if ($b =~ /^[A-Za-z_][A-Za-z0-9_]*=/ || $b =~ $reserved) { $k++; next; }
      if ($b eq "timeout") {
        $k++;
        while ($k < @w && $w[$k]{b} =~ /^-/) { $k += $w[$k]{b} =~ /^-[ks]$/ ? 2 : 1; }
        $k++;
        next;
      }
      last;
    }
    next if $k >= @w || $w[$k]{b} !~ m{^[A-Za-z0-9_./+-]+$};
    my $cmd = $w[$k]{b};
    $cmd =~ s{.*/}{};
    my @args = @w[$k + 1 .. $#w];

    if ($cmd =~ /^g?sed$/ || $cmd eq "perl") {
      my $file = $bulk ? undef : $cmd =~ /^g?sed$/ ? sed_target(\@args) : perl_target(\@args);
      push @found, join("\t", "EDIT", $cmd, $file) if defined $file;
      next;
    }
    if ($cmd =~ /^python(?:\d+(?:\.\d+)*)?$/) {
      push @found, join("\t", "EDIT", $cmd, "-") if !$bulk && python_edits();
      next;
    }

    if ($cmd eq "find") {
      my $j = 0;
      $j++ while $j < @args && $args[$j]{b} =~ /^-[HLP]$/;
      my @depth = map { $args[$_ + 1]{r} } grep { $args[$_]{b} eq "-maxdepth" } 0 .. $#args - 1;
      next if shallow(@depth);
      for (; $j < @args && $args[$j]{b} !~ /^[-!]/; $j++) {
        my $p = resolve($args[$j]{r}, $args[$j]{b});
        push @found, join("\t", "ROOT", $cmd, $p) if defined $p && is_root($p);
      }
      next;
    }

    my $kind = $cmd =~ /^[ef]grep$/ ? "grep" : $cmd;
    next unless $kind =~ /^(?:grep|rg|fd|strings|cat)$/;
    my $parsed = parse($kind, \@args);
    my ($flag, $val, @ops) = ($parsed->{flag}, $parsed->{val}, @{ $parsed->{pos} });
    if ($kind eq "fd") {
      shift @ops;
    } elsif ($kind eq "grep" || $kind eq "rg") {
      my $by_flag = grep { $flag->{$_} } qw(e f regexp file files);
      shift @ops unless $by_flag;
    }

    my @paths = grep { defined } map { resolve($_->{r}, $_->{b}) } @ops;
    push @paths, grep { defined } map { resolve($_, $_) } @{ $val->{"search-path"} // [] } if $kind eq "fd";

    my $recursive = $kind eq "rg" || $kind eq "fd" || $flag->{r} || $flag->{R} || $flag->{recursive}
      || $flag->{"dereference-recursive"} || grep { $_ eq "recurse" } @{ $val->{d} // [] }, @{ $val->{directories} // [] };
    my $limited = ($kind eq "rg" || $kind eq "fd")
      && shallow(@{ $val->{d} // [] }, @{ $val->{"max-depth"} // [] }, @{ $val->{maxdepth} // [] });
    if ($recursive && !$limited) {
      push @found, join("\t", "ROOT", $cmd, $_) for grep { is_root($_) } @paths;
    }
    # grep -r ignores .gitignore, so from a repository root it walks dumps and build output too.
    if ($kind eq "grep" && $recursive) {
      # No operand at all means the cwd; an operand that does not resolve (a glob, a variable) fails open.
      my @roots = @ops ? @paths : (!$has_cd && $cwd ne "" ? ($cwd) : ());
      push @found, join("\t", "REPO", $cmd, $_) for grep { -d $_ && -e "$_/.git" && !is_root($_) } @roots;
    }
    if ($kind eq "grep" || $kind eq "rg" || $kind eq "cat") {
      my $sweep = $kind eq "cat" ? sub { -d $_[0] } : sub { $recursive };
      push @found, join("\t", "TRANSCRIPT", $cmd, $_) for grep { near_projects($_) && $sweep->($_) } @paths;
    }
    my $text = $kind eq "strings" || $flag->{a} || $flag->{text} || grep { $_ eq "text" } @{ $val->{"binary-files"} // [] };
    if ($text && $kind =~ /^(?:grep|rg|strings)$/) {
      push @found, join("\t", "BIG", $cmd, $_) for @paths;
    }
  }

  print "$_\n" for @found;
'

findings="$(perl -e "$scan_src" -- "$cmd" "$blanked" "${HOME:-}" "$cwd" 2>/dev/null)" || exit 0
[ -n "$findings" ] || exit 0

deny() {
    jq -cn --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse",
      permissionDecision: "deny", permissionDecisionReason: $r}}'
    exit 0
}

mmap_recipe() {
    cat <<'EOF'
python3 -I -c 'import mmap,sys; f=open(sys.argv[1],"rb"); m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ); k=sys.argv[2].encode(); i=m.find(k)
for _ in range(20):
    if i<0: break
    print(i, m[max(0,i-150):i+150+len(k)]); i=m.find(k,i+1)' FILE NEEDLE
EOF
}

# 3. Judge each candidate in command order; the first confirmed one denies.
set -f
tab="$(printf '\t')"
nl='
'
old_ifs="$IFS"
IFS="$nl"
for line in $findings; do
    IFS="$old_ifs"
    kind="${line%%"$tab"*}"
    [ "$kind" = EDIT ] || [ "$in_scope" = 1 ] || continue
    rest="${line#*"$tab"}"
    name="${rest%%"$tab"*}"
    path="${rest#*"$tab"}"

    case "$kind" in
        ROOT)
            deny "ac subagent guard: '$name' is rooted at $path, the whole disk or the whole home directory. That search outlives the Bash timeout, Claude Code moves it to the background, and you stay parked on it after your report (about ten such searches timed out in one week).

Search the project or a directory you name instead: spell out the directory (find <dir> -name ...), and use the Glob tool for file names. When the target sits in a gitignored directory, pass that directory as the Grep tool's path rather than running grep or rg over its parent." ;;
        REPO)
            deny "ac subagent guard: a recursive '$name' from the repository root $path ignores .gitignore, so it also walks dumps, build output and dependency trees; one such search in a 44 GB repository ran for 31 minutes in the background and kept its agent parked.

Use rg (or the Grep tool), which honours .gitignore, from the same root. When the text you need sits in an ignored directory, pass that directory as the path explicitly." ;;
        TRANSCRIPT)
            if [ "$history" = 1 ]; then
                deny "ac subagent guard: '$name' over $path reads every session transcript on the machine, which outlives the Bash timeout and leaves you parked on a background shell.

Use the mcp__plugin_ac_ac__search-history tool: it queries an index of past sessions and returns the matching turns with their session ids. Pass the text you were grepping for as the query."
            fi
            deny "ac subagent guard: '$name' over $path reads every session transcript on the machine, which outlives the Bash timeout and leaves you parked on a background shell.

Use the Grep tool with its path set to the one transcript file you need (<project dir>/<session id>.jsonl) and a narrow pattern. Find the file by name with the Glob tool, not by searching the projects directory for content." ;;
        BIG)
            [ -f "$path" ] || continue
            size="$(wc -c < "$path" 2>/dev/null | tr -d ' ')"
            case "$size" in '' | *[!0-9]*) continue ;; esac
            [ "$size" -gt "$max_bytes" ] || continue
            deny "ac subagent guard: '$name' in text mode over $path ($size bytes, above 100 MiB) scans the whole binary, outlives the Bash timeout and leaves you parked on a background shell.

Find the needle with python3 -I -c and mmap.find with a bounded window, a few hundred bytes per hit, and stop after a few hits:

$(mmap_recipe)

Replace FILE with $path and NEEDLE with the literal text. Widen the window only when a hit is cut off." ;;
        EDIT)
            [ "$edit_scope" = 1 ] || continue
            [ "${AC_BASH_EDIT_GUARD:-1}" = 0 ] && continue
            case "$session_id" in '' | *[!A-Za-z0-9_-]*) continue ;; esac
            sum="$(printf '%s' "$cmd" | cksum 2>/dev/null | awk '{print $1 "-" $2}')"
            case "$sum" in [0-9]*-[0-9]*) ;; *) continue ;; esac
            marker_dir="${TMPDIR:-/tmp}/ac-bash-edit-guard"
            marker="$marker_dir/$session_id-$sum"
            # The identical command a second time is a deliberate script; let it run.
            [ -e "$marker" ] && continue
            { mkdir -p "$marker_dir" && : > "$marker"; } 2>/dev/null || continue
            [ "$path" = - ] && target="this file" || target="$path"
            deny "ac subagent guard: make this replacement in $target with the Edit tool rather than a '$name' write. Edit shows the change as a diff, refuses to write over a file that changed since you read it, and keeps the checks that run after an edit in step; a shell write skips all three.

If this writes a new file, an output elsewhere, or rewrites many files, send the same command again and it runs." ;;
    esac
    IFS="$nl"
done
IFS="$old_ifs"
exit 0
