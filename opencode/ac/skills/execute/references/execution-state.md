<!-- ported-from: plugins/ac/skills/execute/references/execution-state.md sha256:b524e4b3495df2b4ebd1b67fd64360d80a346dbac53a7483a945428255d3ef7e -->
# Execution State and the Active-Execution Marker

Read at Phase 1e. The skill body carries the write, the lifecycle rule, and the field list the guards read; this file carries the schema and the reasoning behind each field.

### 1e. Initialize execution state

```
ACCUMULATED_WISDOM = []                 # max 15 items total, max 5 added per wave
MODIFIED_FILES = []                     # tracked across waves; passed to Phase 3 code-review
STEP_FAILURES = []                      # one {step, wave} per step at terminal failure; 2j asks whether
                                        # three of them span two or more waves, which a scalar counter cannot answer
WORKER_RETRY_PER_STEP = {}              # retries spent per step (variant rung, tier rung), max 2
```

No Phase 3 counters live here or anywhere else. The review is one pass and `.ac/plans/<slug>/review-log.md` holds its outcome as a record, per the `## Standing rules` block.

Then write the on-disk active-execution marker at `.ac/state/active-execution.json`. The ac plugin reads it in four places (`../../src/marker.ts` holds the schema, `../../src/run-guards.ts` the readers): the file-scope guard uses it to scope worker edits to the active wave, the standing-rules injection re-states the run's bounds on every request of the owning session, the compaction recovery note names the plan to reload after a compaction, and the stop guard uses its existence to continue a turn that ended while the run is unfinished. It exists only during an active run and is removed on every terminal branch. Call the `ac_session` tool, create `.ac/state/` if absent, then write:

```
{
  "slug": "<plan slug>",
  "session_id": "<session_id from ac_session>",
  "root_session_id": "<root_session_id from ac_session>",
  "harness": "opencode",
  "started_at": "<output of date -u +%Y-%m-%dT%H:%M:%SZ>",
  "current_wave": 1,
  "wave_files": [],
  "note": "<one-line resume hint>"
}
```

Marker schema:
- `slug`: the plan slug. Names which run holds the scope lock, and tells the stop guard and the compaction recovery note which of a repository's many plan directories is the live one. It becomes a path segment under `.ac/plans/`, so the guards reject a slug that is not a plain name.
- `session_id`: this session's own id, copied from `ac_session`; never derive or recall it. Informational: workers run as child sessions with ids of their own, so no guard compares against it.
- `root_session_id`: the top of this session's parent chain, copied from `ac_session`. Load-bearing for every guard: each one walks the calling session's parent chain to its root and acts only when that root matches this field. It scopes the guards to the run that owns the marker, so a marker left behind by another session cannot nudge or scope an unrelated session working in the same repository, and it is how a worker's child session is recognised as part of this run.
- `harness`: exactly `"opencode"`. A marker without it was written by Claude Code and the ac plugin leaves it alone; Claude Code's own hooks in turn never match this marker, because they compare `session_id` with a Claude Code session id. One execute run per repository at a time, whichever harness runs it, since both write the same file.
- `started_at`: written once here and preserved verbatim by every later refresh. Two mechanisms key on it, so changing it mid-run is a real defect: it is the age bound the guards use to treat a marker older than 24 hours as absent, and it is the value in the Phase 3a `## Run` header that scopes this run's review-log entry. Refresh `current_wave`, `wave_files`, and `note`; never this field.
- `current_wave`: the wave index the run is on; refreshed at each wave start (2c). The stop guard's continuation names it.
- `wave_files`: absolute paths of the ACTIVE wave's step Files. The file-scope guard allows a worker edit only when the target resolves inside this set (or under `.ac/`); the orchestrator's own edits are never scoped. Empty until Wave 1 starts, when 2c populates it, and an empty list scopes nothing.
- `note`: a one-line resume hint in plain prose, refreshed at the end of each wave (2f item 3). It is what you read back after a compaction or a restart, so write what a fresh reader needs: which waves are done and committed, and which step to resume at.

Marker lifecycle: written here, with ONLY `current_wave`, `wave_files`, and `note` refreshed at each wave start and barrier (2c, 2f) while `slug`, `session_id`, `root_session_id`, `harness`, and `started_at` stay exactly as written, and deleted at Phase 4 start (4a) plus on every branch that terminates or aborts the run before Phase 4 completes (the 2i / 2j / 3c Stop branches and the error-handling aborts). The marker must never survive a halt: a halt that leaves it behind leaves the stop guard sending continuations, up to its caps, into a run you meant to end.

## Error handling

Marker teardown applies to every halt: delete `.ac/state/active-execution.json` FIRST, before printing anything or
ending the turn. The stop guard reads the marker's presence as "this run is unfinished" and will hand the ended turn
back with the outstanding steps, up to one continuation per stall and three per user prompt. Branches that continue
the run leave the marker in place.

There is no error class for running low on context, on purpose. Compaction handles it and the run continues.

- **Plan not found**: print `Plan not found at <path>. Run /ac/plan first.` and stop. No marker was written yet.
- **Worker output malformed** (no Changes Made / Verification sections): re-spawn the same tier once with a format
  reminder. Still malformed counts as a Phase 2 failure.
- **Worker returns a provider error instead of a report**: the 2e provider-fallback route, `ac_fallback_next` with
  the step's tier and the models it already ran on. Not a step failure until the chain is exhausted.
- **A failed step blocks a later wave**: same semantics as 2i. BLOCKER under auto mode.
- **Wave checkpoint commit fails**: print the git error, then `question` (`Continue without checkpoint` /
  `Abort`). Never auto-retry; a commit failure usually means the tree is in a state you did not expect. BLOCKER.
- **Reviewer subagent returns malformed output**: re-spawn once. Still malformed means you have no review for this run: say so in `report.md` and proceed, rather than inventing a verdict the reviewer no longer returns. A reviewer or oracle call that returns a provider error instead re-spawns on the model `ac_fallback_next` names for its own tier (`plan-code-review`, `oracle`), the same way as a worker.
- **Phase 4 `commit` skill fails**: surface it, then render the report and summary anyway so the work is not lost in
  chat history, and exit with the commit error printed.
