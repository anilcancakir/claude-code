#!/usr/bin/perl
# Run a command under a wall-clock limit and leave nothing of it behind.
#
#   run-bounded.pl SECONDS COMMAND [ARG...]
#
# macOS ships no timeout binary, and the usual stand-in, `perl -e 'alarm N; exec @ARGV'`, kills only the
# process it became. `dart analyze` starts an analysis server of 500 to 700 MB as its child; when the alarm
# killed the parent that server was reparented to launchd and kept analysing, so a timed-out check cost twice:
# once while it ran and once more as an orphan. This runner puts the command in a session of its own, so the
# command and everything it spawns share one process group, and ends that group instead of one process.
#
# The command runs at a lower CPU priority (nice 10), with stdin on /dev/null. On a timeout the group gets
# TERM, then KILL two seconds later. After a normal exit the group is swept as well, so a helper the command
# forgot to stop does not outlive it and cannot hold the caller's output pipe open.
#
# Exit status: the command's own; 128 plus the signal when it died of one; 142 on a timeout (the shell's
# reading of SIGALRM, which the diagnostics hook already matches); 127 when the command cannot start.

use strict;
use warnings;
use POSIX qw(setsid);

my ($secs, @cmd) = @ARGV;
exit 127 unless defined $secs && $secs =~ /^[0-9]+$/ && $secs > 0 && @cmd;

my $pid = fork();
exit 127 unless defined $pid;

if ($pid == 0) {
    setsid();
    setpriority(0, 0, 10);
    open(STDIN, '<', '/dev/null');
    exec { $cmd[0] } @cmd;
    exit 127;
}

my $timed_out = 0;

# Signal the leader as well as the group: a signal that lands before the child has called setsid finds no
# group yet.
my $end_group = sub {
    my ($sig) = @_;
    kill $sig, -$pid;
    kill $sig, $pid;
};

$SIG{ALRM} = sub {
    $timed_out = 1;
    $end_group->('TERM');
    $SIG{ALRM} = sub { $end_group->('KILL') };
    alarm 2;
};

for my $name (qw(TERM INT HUP)) {
    $SIG{$name} = sub {
        $end_group->('KILL');
        exit 128 + ($name eq 'HUP' ? 1 : $name eq 'INT' ? 2 : 15);
    };
}

alarm $secs;
my $reaped;
do { $reaped = waitpid($pid, 0) } while ($reaped == -1 && $!{EINTR});
my $status = $?;
alarm 0;

# The leader is reaped, so only the group is signalled: its pid may already belong to someone else.
kill 'KILL', -$pid;

exit 142 if $timed_out;
exit(128 + ($status & 127)) if $status & 127;
exit($status >> 8);
