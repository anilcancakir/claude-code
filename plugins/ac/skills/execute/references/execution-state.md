# Execution State and the Per-Slug Execute Marker

Read at Phase 1e. The skill body carries the write, the lifecycle rule, and the field list the hooks read; this file carries the schema and the reasoning behind each field.

### 1e. Initialize execution state

```
ACCUMULATED_WISDOM = []                 # max 15 items total, max 5 added per wave
MODIFIED_FILES = []                     # tracked across waves; passed to Phase 3 code-review
STEP_FAILURES = []                      # one {step, wave} per step at terminal failure; 2j asks whether
                                        # three of them span two or more waves, which a scalar counter cannot answer
WORKER_RETRY_PER_STEP = {}              # retries spent per step (effort rung, tier rung), max 2
```

No Phase 3 counters live here or anywhere else. The review is one pass and `.ac/plans/<slug>/review-log.md` holds its outcome as a record, per the `## Standing rules` block.

Then write this run's marker at `.ac/state/execute/<slug>.json`. Each running plan owns one, so several `/ac:execute` runs can share a checkout; the slug is the file name, limited to `[A-Za-z0-9._-]`, and a hook ignores any other name because the slug ends up in paths and in text handed to the model. The hooks act on every marker the current session owns (`${CLAUDE_PLUGIN_ROOT}/hooks/lib/execute-markers.sh`): the PreToolUse file-scope guard scopes worker edits to the union of their `wave_files`, the SessionStart hook names each owned plan after a restart or a compaction, and the `Stop` guard refuses a turn-ending attempt while any owned marker's run is unfinished. The `Stop` guard keeps its block counter beside the marker as `<slug>.stop-guard.json`; the hook writes and owns it, and this skill never touches it. A marker exists only during an active run and is removed on every terminal branch.

Before writing, look for an existing `.ac/state/execute/<slug>.json`. Another slug's marker is another run and never a conflict. This slug's marker with a different `session_id` and a `started_at` under 24 hours old means another session is running this plan: refuse to start, because two runs ticking one plan's checkboxes corrupt its state. One older than 24 hours is abandoned, and one this session owns is a resume; overwrite either. Create `.ac/state/execute/` if absent, then write:

```
{
  "slug": "<plan slug>",
  "pid": <orchestrator process id>,
  "session_id": "<the session id the skill body gives you>",
  "started_at": "<output of date -u +%Y-%m-%dT%H:%M:%SZ>",
  "current_wave": 1,
  "wave_files": [],
  "note": "<one-line resume hint>"
}
```

Marker schema:
- `slug`: the plan slug, equal to the file name. Names which plan this run's `wave_files` belong to, and tells the SessionStart hook which of a repository's many plan directories are live.
- `session_id`: load-bearing for the `Stop` guard, which blocks a turn end only when this field matches the session the hook fired in. Write the id the execute skill body gives in place of `${CLAUDE_SESSION_ID}`; never derive or recall it. It scopes the guard to the run that owns the marker, so a marker left behind by another session cannot block an unrelated session working in the same repository, and it is what the slug-conflict check above compares. Compaction and `--resume` both preserve the session id, so a run that survives either still matches.
- `started_at`: written once here and preserved verbatim by every later refresh. Three mechanisms key on it, so changing it mid-run is a real defect: it is the age bound every hook uses to treat a marker older than 24 hours as stale, it is the `run` key of this slug's `Stop` guard counter, `<slug>.stop-guard.json` (a new value hands the run a fresh budget and clears the spent latch), and it is the value in the Phase 3a `## Run` header that scopes this run's review-log entry. Refresh `current_wave`, `wave_files`, and `note`; never this field.
- `pid`: advisory only. The orchestrator cannot learn its own process id (a `$$` from Bash yields a short-lived subshell that is dead moments later), so write `0` and do not treat this field as a liveness signal. The file-scope hook still consults it for historical reasons; the `Stop` guard deliberately does not.
- `current_wave`: the wave index the run is on; refreshed at each wave start (2c).
- `wave_files`: absolute paths of the ACTIVE wave's step Files. The file-scope hook allows a worker edit only when the target resolves inside the union of the `wave_files` of every marker the session owns (or under `.ac/`). Empty until Wave 1 starts, when 2c populates it.
- `note`: a one-line resume hint in plain prose, refreshed at the end of each wave (2f item 3). The SessionStart hook reads it back verbatim after a compaction or a restart, so write what a fresh reader needs: which waves are done and committed, and which step to resume at.

Marker lifecycle: written here, with ONLY `current_wave`, `wave_files`, and `note` refreshed at each wave start and barrier (2c, 2f) while `slug`, `session_id`, `pid`, and `started_at` stay exactly as written, and deleted at Phase 4 start (4a) plus on every branch that terminates or aborts the run before Phase 4 completes (the 2i / 2j / 3c Stop branches and the error-handling aborts). The marker must never survive a halt: a halt that leaves it behind leaves the `Stop` guard blocking turn ends until its block budget runs out. The one exception is a BLOCKED turn under `LANE_MODE`, below.

## Error handling

Marker teardown applies to every halt: delete this run's `.ac/state/execute/<slug>.json` first (never another slug's), before printing anything or
ending the turn. The `Stop` guard reads the marker's presence as "this run is unfinished" and will block the turn and
hand it back until its block budget is spent. Branches that continue the run leave the marker in place.

Under `LANE_MODE` a BLOCKER does not call `AskUserQuestion` and does not delete the marker. It ends the turn with a `status: BLOCKED` block (class, question, options and recommended label, per `${CLAUDE_PLUGIN_ROOT}/skills/coordinate/references/lane-protocol.md`) and keeps the marker, because the run resumes on `RESOLVE <label>` and then applies that option's own marker handling. `<auto_mode>` in SKILL.md carries the full rule.

There is no error class for running low on context, on purpose. Compaction handles it and the run continues.

- **Plan not found**: print `Plan not found at <path>. Run /ac:plan first.` and stop. No marker was written yet.
- **Worker output malformed** (no Changes Made / Verification sections): re-spawn the same tier once with a format
  reminder. Still malformed counts as a Phase 2 failure.
- **A failed step blocks a later wave**: same semantics as 2i. BLOCKER under auto mode.
- **Wave checkpoint commit fails**: print the git error, then `AskUserQuestion` (`Continue without checkpoint` /
  `Abort`). Never auto-retry; a commit failure usually means the tree is in a state you did not expect. BLOCKER; under `LANE_MODE` it is class `commit`.
- **Reviewer subagent returns malformed output**: re-spawn once. Still malformed means you have no review for this run: say so in `report.md` and proceed, rather than inventing a verdict the reviewer no longer returns.
- **Phase 4 `/ac:commit` fails**: surface it, then render the report and summary anyway so the work is not lost in
  chat history, and exit with the commit error printed. Under `LANE_MODE` the exit is a `status: BLOCKED` block of class `commit`.


