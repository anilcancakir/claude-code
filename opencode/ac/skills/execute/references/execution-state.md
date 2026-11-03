<!-- ported-from: plugins/ac/skills/execute/references/execution-state.md sha256:c4f984753f31eb444a266ed6d1931c060d7dce6f6bebfdafb59f92af04bf8075 -->
# Execution State and the Per-Slug Execute Marker

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

Then write this run's marker at `.ac/state/execute/<slug>.json`. Each running plan owns one, so several execute runs can share a checkout; the slug is the file name, limited to `[A-Za-z0-9._-]`, and the plugin ignores any other name because the slug ends up in paths and in text handed to the model. The ac plugin acts on every marker the current root session owns, in four places (`../../src/marker.ts` holds the schema, `../../src/run-guards.ts` the readers): the file-scope guard scopes worker edits to the union of their `wave_files`, the standing-rules injection re-states the runs' bounds on every request of the owning session, the compaction recovery note names each plan to reload after a compaction, and the stop guard continues a turn that ended while any owned run is unfinished. A `<slug>.stop-guard.json` beside a marker is the Claude Code stop guard's counter, not a run; this skill never touches it. A marker exists only during an active run and is removed on every terminal branch.

Before writing, look for an existing `.ac/state/execute/<slug>.json`. Another slug's marker is another run and never a conflict. This slug's marker owned by another session (a `harness` or `root_session_id` other than yours) with a `started_at` under 24 hours old means another session is running this plan: refuse to start, because two runs ticking one plan's checkboxes corrupt its state. One older than 24 hours is abandoned, and one this session owns is a resume; overwrite either. Call the `ac_session` tool, create `.ac/state/execute/` if absent, then write:

```
{
  "slug": "<plan slug>",
  "session_id": "<session_id from ac_session>",
  "root_session_id": "<root_session_id from ac_session>",
  "harness": "opencode",
  "lane": true,
  "started_at": "<output of date -u +%Y-%m-%dT%H:%M:%SZ>",
  "current_wave": 1,
  "wave_files": [],
  "note": "<one-line resume hint>"
}
```

Marker schema:
- `slug`: the plan slug, equal to the file name. Names which plan this run's `wave_files` belong to, and tells the stop guard and the compaction recovery note which of a repository's many plan directories are live. It becomes a path segment under `.ac/plans/`, so the guards reject a slug that is not a plain name.
- `session_id`: this session's own id, copied from `ac_session`; never derive or recall it. Informational: workers run as child sessions with ids of their own, so no guard compares against it.
- `root_session_id`: the top of this session's parent chain, copied from `ac_session`. Load-bearing for every guard: each one walks the calling session's parent chain to its root and acts only when that root matches this field. It scopes the guards to the run that owns the marker, so a marker left behind by another session cannot nudge or scope an unrelated session working in the same repository, and it is how a worker's child session is recognised as part of this run.
- `harness`: exactly `"opencode"`. A marker without it was written by Claude Code and the ac plugin leaves it alone; Claude Code's own hooks in turn never match this marker, because they compare `session_id` with a Claude Code session id. One execute run per plan at a time, whichever harness runs it, since both write the same per-slug file.
- `lane`: `true` only under `LANE_MODE` (an `ac/lane` session running `--lane`), absent otherwise. The stop guard then sends no continuation, because the coordinator is the lane's supervisor and reads its status block; the file-scope guard and the standing-rules injection still apply. Write it once with the rest of the marker and never refresh it.
- `paused`: optional, `true` while a lane is paused by its coordinator (`PAUSE`), removed on `RESUME`. The plugin's compaction note then tells the lane to wait for `RESUME` instead of continuing from the next unchecked step.
- `started_at`: written once here and preserved verbatim by every later refresh. Two mechanisms key on it, so changing it mid-run is a real defect: it is the age bound the guards use to treat a marker older than 24 hours as absent, and it is the value in the Phase 3a `## Run` header that scopes this run's review-log entry. Refresh `current_wave`, `wave_files`, and `note`; never this field.
- `current_wave`: the wave index the run is on; refreshed at each wave start (2c). The stop guard's continuation names it.
- `wave_files`: absolute paths of the ACTIVE wave's step Files. The file-scope guard allows a worker edit only when the target resolves inside the union of the `wave_files` of every marker the root session owns (or under `.ac/`); the orchestrator's own edits are never scoped. Empty until Wave 1 starts, when 2c populates it, and an empty list scopes nothing.
- `note`: a one-line resume hint in plain prose, refreshed at the end of each wave (2f item 3). It is what you read back after a compaction or a restart, so write what a fresh reader needs: which waves are done and committed, and which step to resume at.

Marker lifecycle: written here, with ONLY `current_wave`, `wave_files`, and `note` refreshed at each wave start and barrier (2c, 2f) while `slug`, `session_id`, `root_session_id`, `harness`, `lane`, and `started_at` stay exactly as written, and deleted at Phase 4 start (4a) plus on every branch that terminates or aborts the run before Phase 4 completes (the 2i / 2j / 3c Stop branches and the error-handling aborts). The marker must never survive a halt: a halt that leaves it behind leaves the stop guard sending continuations, up to its caps, into a run you meant to end.

## Error handling

Marker teardown applies to every halt: delete this run's `.ac/state/execute/<slug>.json` first (never another slug's), before printing anything or
ending the turn. The stop guard reads the marker's presence as "this run is unfinished" and will hand the ended turn
back with the outstanding steps, up to one continuation per stall and three per user prompt. Branches that continue
the run leave the marker in place.

Under `LANE_MODE` a BLOCKER does not call `question` and does not delete the marker. It ends the turn with a `status: BLOCKED` block (class, question, options and recommended label, per `../coordinate/references/lane-protocol.md`) and keeps the marker, because the run resumes on `RESOLVE <label>` and then applies that option's own marker handling. `<auto_mode>` in SKILL.md carries the full rule.

There is no error class for running low on context, on purpose. Compaction handles it and the run continues.

- **Plan not found**: print `Plan not found at <path>. Run /ac/plan first.` and stop. No marker was written yet.
- **Worker output malformed** (no Changes Made / Verification sections): re-spawn the same tier once with a format
  reminder. Still malformed counts as a Phase 2 failure.
- **Worker returns a provider error instead of a report**: the 2e provider-fallback route, `ac_fallback_next` with
  the step's tier and the models it already ran on. Not a step failure until the chain is exhausted.
- **A failed step blocks a later wave**: same semantics as 2i. BLOCKER under auto mode.
- **Wave checkpoint commit fails**: print the git error, then `question` (`Continue without checkpoint` /
  `Abort`). Never auto-retry; a commit failure usually means the tree is in a state you did not expect. BLOCKER; under `LANE_MODE` it is class `commit`.
- **Reviewer subagent returns malformed output**: re-spawn once. Still malformed means you have no review for this run: say so in `report.md` and proceed, rather than inventing a verdict the reviewer no longer returns. A reviewer or oracle call that returns a provider error instead re-spawns on the model `ac_fallback_next` names for its own tier (`plan-code-review`, `oracle`), the same way as a worker.
- **Phase 4 `commit` skill fails**: surface it, then render the report and summary anyway so the work is not lost in
  chat history, and exit with the commit error printed. Under `LANE_MODE` the exit is a `status: BLOCKED` block of class `commit`.
