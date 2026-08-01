# Execution State and the Active-Execution Marker

Read at Phase 1e. The skill body carries the write, the lifecycle rule, and the field list the hooks read; this file carries the schema and the reasoning behind each field.

### 1e. Initialize execution state

```
ACCUMULATED_WISDOM = []                 # max 15 items total, max 5 added per wave
MODIFIED_FILES = []                     # tracked across waves; passed to Phase 3 code-review
STEP_FAILURE_COUNT = 0                  # Phase 2 3-strike rule counter; increments when a step fails after tier escalation retry
WORKER_RETRY_PER_STEP = {}              # max 1 tier-escalation retry per step
```

The Phase 3 revision-loop counters are deliberately absent here. They are derived from `.ac/plans/<slug>/review-log.md` at the top of every pass (Phase 3d), per the `## Standing rules` block.

Then write the on-disk active-execution marker at `.ac/state/active-execution.json`. Three plugin hooks read it: the PreToolUse file-scope guard uses it to scope worker edits to the active wave, the SessionStart hook uses it to name the active plan after a restart or a compaction, and the `Stop` guard uses its existence to refuse a turn-ending attempt while the run is unfinished. It exists only during an active run and is removed on every terminal branch. Create `.ac/state/` if absent, then write:

```
{
  "slug": "<plan slug>",
  "pid": <orchestrator process id>,
  "session_id": "<current session id>",
  "started_at": "<ISO-8601 UTC timestamp>",
  "current_wave": 1,
  "wave_files": [],
  "note": "<one-line resume hint>"
}
```

Marker schema:
- `slug`: the plan slug. Names which run holds the scope lock, and tells the SessionStart hook which of a repository's many plan directories is the live one.
- `session_id`: load-bearing for the `Stop` guard, which blocks a turn end only when this field matches the session the hook fired in. Write the real current session id. It scopes the guard to the run that owns the marker, so a marker left behind by another session cannot block an unrelated session working in the same repository. Compaction and `--resume` both preserve the session id, so a run that survives either still matches.
- `started_at`: written once here and preserved verbatim by every later refresh. Three mechanisms key on it, so changing it mid-run is a real defect: it is the age bound every hook uses to treat a marker older than 24 hours as stale, it is the `run` key of the `Stop` guard's block counter (a new value hands the run a fresh budget and clears the spent latch), and it is the value in the Phase 3a `## Run` header that scopes the review loop's counters. Refresh `current_wave`, `wave_files`, and `note`; never this field.
- `pid`: advisory only. The orchestrator cannot learn its own process id (a `$$` from Bash yields a short-lived subshell that is dead moments later), so write `0` and do not treat this field as a liveness signal. The file-scope hook still consults it for historical reasons; the `Stop` guard deliberately does not.
- `current_wave`: the wave index the run is on; refreshed at each wave start (2c).
- `wave_files`: absolute paths of the ACTIVE wave's step Files. The file-scope hook allows a worker edit only when the target resolves inside this set (or under `.ac/`). Empty until Wave 1 starts, when 2c populates it.
- `note`: a one-line resume hint in plain prose, refreshed at each wave barrier (2f step 5). The SessionStart hook reads it back verbatim after a compaction or a restart, so write what a fresh reader needs: which waves are done and committed, and which step to resume at.

Marker lifecycle: written here, with ONLY `current_wave`, `wave_files`, and `note` refreshed at each wave start and barrier (2c, 2f) while `slug`, `session_id`, `pid`, and `started_at` stay exactly as written, and deleted at Phase 4 start (4a) plus on every branch that terminates or aborts the run before Phase 4 completes (the 2i / 2j / 3d Stop branches and the error-handling aborts). The marker must never survive a halt: a halt that leaves it behind leaves the `Stop` guard blocking turn ends until its block budget runs out.

## Error handling

Marker teardown applies to every halt: delete `.ac/state/active-execution.json` FIRST, before printing anything or
ending the turn. The `Stop` guard reads the marker's presence as "this run is unfinished" and will block the turn and
hand it back until its block budget is spent. Branches that continue the run leave the marker in place.

There is no error class for running low on context, on purpose. Compaction handles it and the run continues.

- **Plan not found**: print `Plan not found at <path>. Run /ac:plan first.` and stop. No marker was written yet.
- **Worker output malformed** (no Changes Made / Verification sections): re-spawn the same tier once with a format
  reminder. Still malformed counts as a Phase 2 failure.
- **A failed step blocks a later wave**: same semantics as 2i. BLOCKER under auto mode.
- **Wave checkpoint commit fails**: print the git error, then `AskUserQuestion` (`Continue without checkpoint` /
  `Abort`). Never auto-retry; a commit failure usually means the tree is in a state you did not expect. BLOCKER.
- **Reviewer subagent returns malformed output**: re-spawn once. Still malformed counts as BLOCKED with the raw
  output noted in the revision loop.
- **Phase 4 `/ac:commit` fails**: surface it, then render the report and summary anyway so the work is not lost in
  chat history, and exit with the commit error printed.


