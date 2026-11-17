# Long-running watches

Read this only for what the `Monitor` tool's own description does not carry. That description
already covers the mechanism table, the unbounded-watch mistake, per-stage buffering, the
silence-is-not-success rule, WebSocket sources and output volume, and it arrives with the tool. Do
not restate any of it here; a second copy drifts from the first and neither wins.

What is left is the part the tool cannot know: why it is the only watch primitive on this machine,
and two worked shapes that are longer than a tool description carries.

## Why cron is not the answer here

The Group D scheduling trim in `install-settings.md` denies `CronCreate`, `CronDelete`,
`CronList`, `ScheduleWakeup`, `RemoteTrigger` and `TaskOutput`, and turns the `loop` and `schedule`
skills off. `permissions.deny` strips a tool's schema rather than only blocking the call, so for a
trimmed operator those tools are ABSENT: there is nothing to reach for and no denial comes back.
Nothing announces the gap either, which is the problem this file and the Watching sentence under
`## My workflow` in the global CLAUDE.md exist to close.

The gap has a second half worth naming. The `schedule` skill body is the only built-in that points
cron work at `Monitor` ("streams events as they happen; cron polls on a schedule"), and Group D
turns that skill off, so the trim removes the signpost along with the road.

This matters before `ToolSearch` rather than after. `Monitor` sets `shouldDefer: true`, so its
description arrives only once the model has already decided to reach for it, and the deferred-tools
reminder carries bare names with no search hint. The decision to watch at all happens a turn
earlier. That is why the generated global CLAUDE.md carries a short Watching sentence under
`## My workflow`, and why this file restates nothing the tool description already delivers.

Cron is the wrong shape even where it survives, for one verified reason: jobs fire only while the
REPL sits idle, never mid-query.

## Two shapes worth keeping

The schema takes `command`, `description`, `timeout_ms` and `ws`, rejects any other key
(`additionalProperties: false`), and requires `description` and `timeout_ms`. A `timeout_ms` above
1800000 is capped to 1800000 (30 minutes), so a longer watch is re-armed when the monitor expires.

Poll a deployment at ten-minute intervals for the 30 minutes one monitor lasts; the loop ends just
before the deadline so it reports completion instead of being killed, and a watch that must go on is
armed again:

```
Monitor({timeout_ms: 1800000, description: "deploy health, 10m interval", command: '
  end=$(( $(date +%s) + 1700 ))
  while [ $(date +%s) -lt $end ]; do
    curl -sf https://app.example.com/health || echo "HEALTH FAIL $(date +%H:%M)"
    kubectl get pods 2>&1 | grep -E "CrashLoop|Error|Evicted" || true
    sleep 600
  done
  echo "30m watch complete"'})
```

Follow a pull request to its CI verdict, with each check, comment and review arriving as its own
line and a `VERDICT` line at the end:

```
Monitor({description: "PR 123 CI and reviews", timeout_ms: 1800000, command: "timeout 1800 node <plugin root>/cli/ac.js pr-watch 123 --ignore 'Kodizm review'"})
```

This one is a command and not a loop because `ac pr-watch` dedupes comments against what existed
when it started, pins the pushed head, and ends with a verdict and an exit code that a hand-written
poll loop does not give. `plugins/ac/references/verification.md` ("Projects that gate on CI") has the
line meanings and what to do on each verdict; `<plugin root>` is the directory the calling skill names, since
the plugin-root variable is not set in the shell.

## Two gates that change what any of this means

`Monitor` sits behind a feature flag that defaults to false, so an operator can receive the
Watching sentence and the main-thread working rules and have no such tool. That degrades correctly
on its own: `Run to completion` in `plugins/ac/references/working-rules.md` already says to
substitute the nearest working mechanism and say so. Do not add a hedge to either for it.

The tool's own description branches on `backgroundTasksDisabled`. With background tasks disabled it
stops recommending `Bash` with `run_in_background` for the single-notification case and points at a
foreground `until` loop instead. The `Run to completion` rule in `working-rules.md` names
`run_in_background`, so on a machine with that setting the rule and the description disagree by one
word. Check the setting before trusting either.
