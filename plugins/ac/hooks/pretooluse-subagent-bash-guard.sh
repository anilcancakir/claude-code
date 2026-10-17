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
# What it denies, for ac agents only (`ac:<name>`, or one of the eleven bare names for an agent
# installed unprefixed):
#   a. `find`, recursive `grep`, `rg` or `fd` whose search root is `/` or the home directory, unless
#      `-maxdepth` (find) or `--max-depth`/`-d` (rg, fd) limits the walk to 2 levels or fewer.
#   b. recursive `grep`, `rg`, or `cat` of a directory, over ~/.claude/projects itself or one project
#      directory under it. A regular file there (one transcript, memory/MEMORY.md) is a bounded read.
#   c. `strings`, or `grep`/`rg` in text mode (-a, --text, --binary-files=text), on a regular file
#      over 100 MiB.
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

# 1. Scope. A main-thread call carries no agent_type, which is what leaves the orchestrator alone.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)"
ac_agent_in_scope "$agent_type" || exit 0

# Oracle, librarian, plan-reviewer and plan-code-review inherit the MCP search-history tool through a
# denylist, while the other agents are allowlisted without it, so only these four are pointed at it.
case "$agent_type" in
    oracle | ac:oracle | librarian | ac:librarian | plan-reviewer | ac:plan-reviewer \
        | plan-code-review | ac:plan-code-review) history=1 ;;
    *) history=0 ;;
esac

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0
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
    $start = $i if $start < 0;
  }

  my @found;
  my $reserved = qr/^(?:!|then|do|else|elif|if|while|until|time|command|exec|nohup|sudo|env|builtin)$/;

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
    rest="${line#*"$tab"}"
    name="${rest%%"$tab"*}"
    path="${rest#*"$tab"}"

    case "$kind" in
        ROOT)
            deny "ac subagent guard: '$name' is rooted at $path, the whole disk or the whole home directory. That search outlives the Bash timeout, Claude Code moves it to the background, and you stay parked on it after your report (about ten such searches timed out in one week).

Search the project or a directory you name instead: spell out the directory (find <dir> -name ...), and use the Glob tool for file names. When the target sits in a gitignored directory, pass that directory as the Grep tool's path rather than running grep or rg over its parent." ;;
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
    esac
    IFS="$nl"
done
IFS="$old_ifs"
exit 0
