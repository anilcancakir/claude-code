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
Nothing announces the gap either, which is the problem this file and the CLAUDE.md section exist
to close.

The gap has a second half worth naming. The `schedule` skill body is the only built-in that points
cron work at `Monitor` ("streams events as they happen; cron polls on a schedule"), and Group D
turns that skill off, so the trim removes the signpost along with the road.

This matters before `ToolSearch` rather than after. `Monitor` sets `shouldDefer: true`, so its
description arrives only once the model has already decided to reach for it, and the deferred-tools
reminder carries bare names with no search hint. The decision to watch at all happens a turn
earlier. That is why the generated global CLAUDE.md carries a short `Watching something over time`
section, and why this file restates nothing the tool description already delivers.

Cron is the wrong shape even where it survives, for one verified reason: jobs fire only while the
REPL sits idle, never mid-query.

## Two shapes worth keeping

`description`, `timeout_ms` and `persistent` are all required by the schema, whatever defaults the
validator carries. Both calls below pass all three; a call that omits one is rejected before it
runs.

Poll a deployment for two hours at ten-minute intervals. The one-hour `timeout_ms` ceiling is why
this one is `persistent`, and `timeout_ms` is ignored once it is:

```
Monitor({persistent: true, timeout_ms: 3600000, description: "deploy health, 10m interval", command: '
  end=$(( $(date +%s) + 7200 ))
  while [ $(date +%s) -lt $end ]; do
    curl -sf https://app.example.com/health || echo "HEALTH FAIL $(date +%H:%M)"
    kubectl get pods 2>&1 | grep -E "CrashLoop|Error|Evicted" || true
    sleep 600
  done
  echo "2h watch complete"'})
```

Follow a pull request to its CI verdict, emitting each check as it lands and stopping when the run
completes:

```
Monitor({description: "PR 123 CI checks", timeout_ms: 3600000, persistent: false, command: '
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket) || { sleep 30; continue; }
    cur=$(jq -r ".[] | select(.bucket != \"pending\") | \"\(.name): \(.bucket)\"" <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e "all(.bucket != \"pending\")" <<<"$s" >/dev/null && break
    sleep 30
  done'})
```

The `|| { sleep 30; continue; }` is the line to copy. One failed API call should not kill a watch
with an hour left to run, and a poll loop without it dies on the first rate limit.

## Two gates that change what any of this means

`Monitor` sits behind a feature flag that defaults to false, so an operator can receive the
CLAUDE.md section and have no such tool. That degrades correctly on its own: `Staying on the task`
already says to substitute the nearest working mechanism and say so. Do not add a hedge to the
section for it.

The tool's own description branches on `backgroundTasksDisabled`. With background tasks disabled it
stops recommending `Bash` with `run_in_background` for the single-notification case and points at a
foreground `until` loop instead. The CLAUDE.md section names `run_in_background`, so on a machine
with that setting the section and the description disagree by one word. Check the setting before
trusting either.
