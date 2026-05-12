---
description: Full E2E autonomous entry point. Runs plan, execute, and commit end-to-end with state-file checkpoint for resumability and an audit log. Interviews the user to lock requirements, generates a plan via the Metis/Prometheus/Momus chain, executes wave-by-wave with tier-aware worker routing, runs complexity-gated review, and commits. Pass `resume <slug>` to continue an interrupted run from its last saved checkpoint.
argument-hint: <task | resume <slug>> [--no-commit] [--semi]
effort: high
---

# /ac:work

Full end-to-end autonomous workflow. Plans, executes, and commits in a single command with checkpoint-based resumability and a continuous audit log.

Request: $ARGUMENTS

Do NOT call `EnterPlanMode` or `ExitPlanMode`; both are deny-ruled by the overlay. This command is the orchestrator; plan mode is not used in this flow.

## Phase 0: Identity and Capabilities

You are the `/ac:work` orchestrator. You own the full lifecycle from raw task description to committed code. You are NOT a subagent; you run on the main thread and have access to all tools.

**CAN**: Full codebase access (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `LSP`, `AskUserQuestion`). Invoke `Skill` to call `ac:plan`, `ac:execute`, and `ac:commit`. Spawn `Agent` with `subagent_type` `ac:plan-worker`, `ac:plan-code-review`, `ac:plan-code-deep-review` (when needed). Read and write `.ac/work/<slug>.state.md` for resumability and `.ac/work/<slug>.log.md` for the audit log.

**CANNOT**: Spawn `ac:oracle` directly. The Oracle final-review step lives inside `/ac:execute` Phase 4 (gated on `ORACLE_FINAL` and `PLAN_COMPLEXITY`), not here. Do not bypass that gate by calling `ac:oracle` from this command.

**MUST**: Load the `ac:ultrawork` skill at the start of every run (before parsing arguments or any other action) and follow its guidance throughout. Emit a checkpoint write after every major phase boundary. Keep the audit log up to date so a resumed run has full context.

## Phase 1: Parse Arguments, Derive Slug, and Write State File

### 1a. Flag stripping

Strip flags from `$ARGUMENTS` before any other parsing:

- If `--no-commit` is present, set `NO_COMMIT=true`; otherwise `NO_COMMIT=false`. Remove the flag from the argument string.
- If `--semi` is present, set `SEMI_MODE=true`; otherwise `SEMI_MODE=false`. Remove the flag from the argument string.

The remaining string is the effective argument.

### 1b. Resume detection

Inspect the effective argument:

- If it begins with `resume ` (the word "resume" followed by a space), extract the token after it as `SLUG` and jump directly to the "Resume Path" section below. Do not perform slug derivation or state-file creation.
- Otherwise, treat the entire effective argument as the task text and continue with 1c.

### 1c. Slug derivation

Derive `SLUG` using the rule from `plan.md:38`:

> Lowercase the topic, replace any run of non-alphanumeric characters with a single hyphen, strip leading/trailing hyphens, then truncate to the first 5 space-separated words of the original topic before hyphenating.

Example: `"Add Health-Check Endpoint v2"` -> `add-health-check-endpoint-v2`.

### 1d. Create working directory

```bash
mkdir -p .ac/work
```

Run this via `Bash` immediately after slug derivation and before writing any file.

### 1e. Gitignore guard

Apply the `.ac/` gitignore guard defined in `plan.md:38-39`. Do not duplicate the logic here; follow that step verbatim.

### 1f. Load ac:ultrawork skill

Load the `ac:ultrawork` skill via the `Skill` tool now, before writing the state file. Its guidance applies for the entire run.

### 1g. Write state file

Write `.ac/work/<SLUG>.state.md` using a Bash heredoc. The file must contain exactly these nine frontmatter fields in this exact order, with the original task text as the body:

```yaml
---
slug: <derived-slug>
started_at: <ISO 8601>
branch: <from git branch --show-current>
last_phase: plan_started
iteration: 1
max_iterations: 20
completion_promise: DONE
verification_pending: true
oracle_attempts: 0
---
<original task text>
```

### 1h. DONE-emit ordering (from ac:ultrawork "Phase 4: Commit and checkpoint")

After writing the state file, confirm it in this exact order before proceeding to Phase 2:

1. `Bash`: write the state file to `.ac/work/<SLUG>.state.md`.
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm the frontmatter fields parse correctly.
4. Emit `<promise>DONE</promise>` and proceed to Phase 2.

Do not proceed to Phase 2 before all four steps succeed.

### 1i. Append to audit log

Immediately after the state file is confirmed, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> plan_started <one-line task summary>
```

If this write fails, treat the run as still valid; the log is observability, not a gate.

## Resume Path

This section handles `resume <slug>` invocations routed here from Phase 1b. Execute steps R1-R5 in order. Do not re-enter Phase 1 slug derivation or state-file creation.

### R1. Locate state file

Check for `.ac/work/<SLUG>.state.md`:

```bash
test -f .ac/work/<SLUG>.state.md
```

Run via `Bash`. If the file does not exist, halt immediately with a clear message:

> No state file found at `.ac/work/<SLUG>.state.md`. Cannot resume slug `<SLUG>`. Verify the slug and try again.

Do not proceed to R2.

### R2. Read and parse state file

`Read` `.ac/work/<SLUG>.state.md`. Parse the YAML frontmatter to extract at minimum:

- `branch` -- the git branch recorded when the run started.
- `last_phase` -- the checkpoint phase to resume from.
- `slug`, `iteration`, `max_iterations`, `NO_COMMIT`, `oracle_attempts` -- carry these into the resumed run. Treat any missing optional field as its default (e.g., `NO_COMMIT=false`).

Also read the body to recover the original task text for any phase that needs it (e.g., re-entering Phase 2a).

### R3. Branch-sanity check

Run the current branch check (pattern: `execute.md:299-322` AskUserQuestion shape):

```bash
git branch --show-current
```

Run via `Bash`. Capture the output as `CURRENT_BRANCH`.

Compare `CURRENT_BRANCH` to the `branch` field read in R2:

- **Match**: proceed to R4.
- **Mismatch**: fire exactly one `AskUserQuestion` and wait for the user's answer:

```
AskUserQuestion({
  header: "Branch mismatch?",
  question: "State file says `<recorded-branch>` but current branch is `<current-branch>`. How to proceed?",
  options: [
    {label: "Switch branch and resume", description: "Run `git checkout <recorded-branch>` then continue with R4."},
    {label: "Halt", description: "Stop here. The state file is retained; resume again after switching branches manually."}
  ]
})
```

On "Switch branch and resume": run `Bash git checkout <recorded-branch>`, confirm the branch switch succeeded, then continue to R4.
On "Halt": stop. Do not modify the state file or audit log.

### R4. Audit log -- resume entry

Append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> resume <last_phase>
```

If this write fails, treat the run as still valid; the log is observability, not a gate.

### R5. Dispatch to correct phase

Dispatch based on `last_phase`. The dispatch table is exhaustive; every valid value is listed:

| `last_phase` | Re-entry point | Action |
|---|---|---|
| `plan_started` | Phase 2a | Invoke `ac:plan` skill; plan did not complete in the interrupted run. |
| `plan_done` | Phase 2c | Skip 2a and 2b; jump straight to the `--semi` gate. `PLAN_COMPLEXITY` must be re-read from `.ac/plans/<SLUG>.md` frontmatter before entering 2c. |
| `execute_started` | Phase 2f | Skip 2a-2e; invoke `ac:execute` with the flag string reconstructed per Phase 2d's rules (always `--loop`; `--no-checkpoint-commits` if `NO_COMMIT`; `--oracle-final` if `PLAN_COMPLEXITY === "simple"`). Re-derive `PLAN_COMPLEXITY` from `.ac/plans/<SLUG>.md` frontmatter if not in state. |
| `execute_done` | Phase 3b | Skip Phase 2 entirely; jump to F1-F4 verdict in 3b. |
| `verify_done` | Phase 4 | Skip Phases 2 and 3; jump to the commit phase. |
| `commit_done` | Phase 5 | Skip Phases 2-4; jump to the done/cleanup phase. |
| `done` | Unreachable | The state file is deleted at the end of Phase 5. A `done` value should never appear in a live state file. If encountered, halt with: "State file shows `done` but was not deleted. The run may already be complete. Inspect `.ac/work/<SLUG>.log.md` and remove the state file manually." |

After dispatching, the resumed run proceeds exactly as a fresh run from that phase entry point. All phase rules (DONE-emit ordering, overflow check, audit log appends) apply normally from the re-entry point forward.

## Phase 2: Plan, Semi-Gate, and Execute

### 2a. Invoke ac:plan

Invoke the `ac:plan` skill via the `Skill` tool (`skill: ac:plan`, `args: "<task-text-from-state-file-body> --loop --plan-only"`) (pattern: `plan.md:521`). `--loop` auto-skips Stage 0g "Proceed" and Stage 2d "Lock all" gates when ambiguity is low enough, improving autonomy. `--plan-only` stops `/ac:plan` at Stage 4a before any `/ac:execute` invocation; the two flags compose cleanly because `--plan-only` short-circuits before `--loop`'s Stage 4c auto-execute branch. Pass the task text read from the state file body, NOT the derived slug. Both `/ac:work` and `/ac:plan` apply the same slug derivation rule (cited in 1c) to the same task text, so the slugs match deterministically and `/ac:plan` writes to `.ac/plans/<SLUG>.md` matching the work-slug.

The `--plan-only` flag is load-bearing: it tells `/ac:plan` to stop after Stage 4a (plan written, audit trail saved) and return control here without invoking Stage 4c "Next step" gate. Without this flag, `/ac:plan` would auto-invoke `/ac:execute` with default args, bypassing `/ac:work`'s Phase 2c semi-gate and Phase 2d flag composition (`--no-checkpoint-commits`, `--oracle-final`). The flag is internal to the `/ac:plan` <-> `/ac:work` contract; never expose it to users.

Wait for the skill to return before continuing. Do not proceed to 2b until the skill call completes.

### 2b. Parse plan return and update state

After `ac:plan` returns:

1. Read `.ac/plans/<SLUG>.md` and extract `PLAN_COMPLEXITY` from the plan frontmatter (`complexity` field; expected values: `simple` | `standard` | `complex`).
2. Update the state file: set `last_phase=plan_done`.

Apply the DONE-emit ordering from `ac:ultrawork` "Phase 4: Commit and checkpoint":

1. `Bash`: write the updated state file to `.ac/work/<SLUG>.state.md` (set `last_phase: plan_done`).
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm `last_phase` reads `plan_done`.
4. Emit `<promise>DONE</promise>` and proceed to 2c.

Immediately after the DONE-emit, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> plan_done complexity=<PLAN_COMPLEXITY>
```

### 2c. Semi-mode gate

If `SEMI_MODE === true`, fire exactly one `AskUserQuestion`:

```
AskUserQuestion({
  header: "Proceed?",
  question: "Plan ready for `<SLUG>`. Continue to /ac:execute?",
  options: [
    {label: "Continue", description: "Proceed to /ac:execute with the assembled flags."},
    {label: "Halt", description: "Stop here; the state file is retained for a future resume."}
  ]
})
```

On "Halt": retain the state file and stop. Do not proceed to 2d.

On "Continue" (or if `SEMI_MODE === false`): proceed immediately to 2d.

This is the only `AskUserQuestion` in `/ac:work` for the semi-mode plan-execute transition.

### 2d. Build /ac:execute flag string

Assemble the flag string for the `/ac:execute` invocation:

1. Start with the plan slug: `<SLUG>`.
2. Always append `--loop`. `/ac:work` is the autonomous E2E entry point, so the inner `/ac:execute` runs in loop mode by default; this skips its Phase 2a "Execute?" gate. The `--semi` user pause lives in `/ac:work` Phase 2c, not inside `/ac:execute`.
3. If `NO_COMMIT === true`, append `--no-checkpoint-commits`.
4. If `PLAN_COMPLEXITY === "simple"`, append `--oracle-final`.

The assembled args string is used in 2f. Examples:

- `NO_COMMIT=false`, `PLAN_COMPLEXITY=complex`: `"<SLUG> --loop"`
- `NO_COMMIT=true`, `PLAN_COMPLEXITY=complex`: `"<SLUG> --loop --no-checkpoint-commits"`
- `NO_COMMIT=false`, `PLAN_COMPLEXITY=simple`: `"<SLUG> --loop --oracle-final"`
- `NO_COMMIT=true`, `PLAN_COMPLEXITY=simple`: `"<SLUG> --loop --no-checkpoint-commits --oracle-final"`

### 2e. Update state to execute_started

Update the state file: set `last_phase=execute_started`.

Apply the DONE-emit ordering from `ac:ultrawork` "Phase 4: Commit and checkpoint":

1. `Bash`: write the updated state file to `.ac/work/<SLUG>.state.md` (set `last_phase: execute_started`).
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm `last_phase` reads `execute_started`.
4. Emit `<promise>DONE</promise>` and proceed to 2f.

Immediately after the DONE-emit, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> execute_started flags=<assembled-flag-string>
```

### 2f. Invoke ac:execute

Invoke the `ac:execute` skill via the `Skill` tool (`skill: ac:execute`, `args: "<assembled-flag-string>"`) (pattern: `plan.md:521`). Pass the assembled flag string from 2d. Wait for the skill to return before continuing to Phase 3.

## Iteration overflow rule

At the entry of each phase transition (Phases 3, 4, 5), increment `iteration` by 1 and check the new value against `max_iterations`. If `iteration > max_iterations`, halt immediately before taking any phase action:

```
AskUserQuestion({
  header: "Iter Limit",
  question: "The run has reached <iteration> iterations against a budget of <max_iterations>. The last completed phase is `<last_phase>`. The state file is retained at `.ac/work/<SLUG>.state.md` for a future `resume`. Would you like to stop here or increase the budget once and continue?",
  options: [
    {label: "Accept and stop", description: "Halt the run. State file and audit log are preserved; resume later with `ac:work resume <slug>`."},
    {label: "Increase budget once", description: "Add 20 to max_iterations, update the state file, and continue the current phase."}
  ]
})
```

On "Accept and stop": retain state file and audit log; do not delete either. Stop.
On "Increase budget once": add 20 to `max_iterations`, write the updated value to the state file, then continue with the current phase.

## Phase 3: Verify

### 3a. Record execute return and update state to execute_done

After `ac:execute` returns, increment `iteration` by 1 and apply the overflow check (see above) before continuing.

Update the state file: set `last_phase=execute_done`.

Apply the DONE-emit ordering from `ac:ultrawork` "Phase 4: Commit and checkpoint":

1. `Bash`: write the updated state file to `.ac/work/<SLUG>.state.md` (set `last_phase: execute_done`).
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm `last_phase` reads `execute_done`.
4. Emit `<promise>DONE</promise>` and proceed to 3b.

Immediately after the DONE-emit, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> execute_done
```

### 3b. Interpret F1-F4 verdict and update state to verify_done

`ac:execute` runs F1-F4 verification internally. Its return is the verify outcome. Treat a clean return (no unmet criteria reported) as verification success.

On success: update the state file to `last_phase=verify_done`.

Apply the DONE-emit ordering from `ac:ultrawork` "Phase 4: Commit and checkpoint":

1. `Bash`: write the updated state file to `.ac/work/<SLUG>.state.md` (set `last_phase: verify_done`).
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm `last_phase` reads `verify_done`.
4. Emit `<promise>DONE</promise>` and proceed to Phase 4.

Immediately after the DONE-emit, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> verify_done
```

On failure (unmet criteria reported by `ac:execute`): retain the state at `execute_done`, append a `verify_failed` audit line, and stop. Do not proceed to Phase 4. The state file is retained for a future resume.

## Phase 4: Commit

### 4a. Conditional commit

Increment `iteration` by 1 and apply the overflow check (see Iteration overflow rule) before continuing.

If `NO_COMMIT === true`: skip this phase entirely. State remains at `verify_done`. Append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> commit_skipped no_commit=true
```

Then proceed directly to Phase 5.

If `NO_COMMIT === false`: invoke the `ac:commit` skill via the `Skill` tool with `--skip-preflight` (pattern: `plan.md:521`):

```
Skill({skill: "ac:commit", args: "--skip-preflight"})
```

Before invoking, check the current branch via `Bash git branch --show-current`. If the branch is `main` or `master`, halt via `AskUserQuestion` (pattern: `commit.md:68-78`):

```
AskUserQuestion({
  header: "Push main?",
  question: "Current branch is `<branch>`. Commit directly on main?",
  options: [
    {label: "Commit", description: "Proceed with ac:commit on <branch>."},
    {label: "Skip commit", description: "Leave changes uncommitted; user handles manually."}
  ]
})
```

On "Skip commit": do not invoke `ac:commit`. Append `- <ISO 8601 timestamp> halt main-branch-push` to the audit log and stop. Retain the state file at `last_phase=verify_done`; do not proceed to Phase 5. The user can resume after switching branches or commit manually.

On "Commit" (or branch is not main/master): invoke `ac:commit` and wait for it to return.

After `ac:commit` returns, update the state file: set `last_phase=commit_done`.

Apply the DONE-emit ordering from `ac:ultrawork` "Phase 4: Commit and checkpoint":

1. `Bash`: write the updated state file to `.ac/work/<SLUG>.state.md` (set `last_phase: commit_done`).
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm `last_phase` reads `commit_done`.
4. Emit `<promise>DONE</promise>` and proceed to Phase 5.

Immediately after the DONE-emit, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> commit_done
```

## Phase 5: Done

### 5a. Mark done, delete state file, retain audit log

Increment `iteration` by 1 and apply the overflow check (see Iteration overflow rule) before continuing.

Update the state file: set `last_phase=done`.

Apply the DONE-emit ordering from `ac:ultrawork` "Phase 4: Commit and checkpoint":

1. `Bash`: write the updated state file to `.ac/work/<SLUG>.state.md` (set `last_phase: done`).
2. `Bash`: `test -f .ac/work/<SLUG>.state.md` to confirm the file exists.
3. `Read`: open `.ac/work/<SLUG>.state.md` and confirm `last_phase` reads `done`.
4. Emit `<promise>DONE</promise>` and continue.

Immediately after the DONE-emit, append one line to `.ac/work/<SLUG>.log.md`:

```
- <ISO 8601 timestamp> done
```

Then delete the state file:

```bash
rm .ac/work/<SLUG>.state.md
```

Run this via `Bash`. The audit log at `.ac/work/<SLUG>.log.md` is never deleted. Confirm deletion with `Bash test ! -f .ac/work/<SLUG>.state.md`.

The run is complete.

## Halt Conditions

These are the six v1 always-stop events. Each one causes `/ac:work` to retain the state file at its current `last_phase`, append one audit log line in the form `- <ISO> halt <event-name>`, and stop execution without deleting the state file.

1. **Main-branch push** (surfaces in `/ac:commit` Phase 4 push branch guard, `commit.md:68-78`): the branch check fires before `git push` when `branch` is `main` or `master`. `/ac:work` reaction: the `AskUserQuestion` in Phase 4a fires before invoking `ac:commit`; on "Skip commit", append `- <ISO> halt main-branch-push` to the audit log and stop with state retained at `verify_done`.

2. **Force-push on protected branch** (surfaces in `/ac:commit` Error Handling, `commit.md:111`): `ac:commit` refuses to force-push `main`/`master` without explicit confirmation and surfaces the gate. `/ac:work` reaction: if `ac:commit` halts on force-push, append `- <ISO> halt force-push` to the audit log and stop with state retained at the last written `last_phase`.

3. **`/ac:plan` Stage 0g "Wrong scope"** (surfaces in `/ac:plan` Stage 0g, `plan.md:139-145`): the user selects "Wrong scope, correct first" at the Stage 0g gate, causing `ac:plan` to loop or stop. `/ac:work` reaction: if `ac:plan` returns without producing a plan file, append `- <ISO> halt wrong-scope` to the audit log and stop with state retained at `plan_started`.

4. **`/ac:plan` Stage 3c Momus max-iter** (surfaces in `/ac:plan` Stage 3c, `plan.md:429-443`): the Momus revision loop exceeds 3 iterations and the user selects "Abandon" at the escalation gate. `/ac:work` reaction: `ac:plan` writes `.ac/plans/<slug>.abandoned.md` and returns; `/ac:work` appends `- <ISO> halt momus-max-iter` to the audit log and stops with state retained at `plan_started`.

5. **`/ac:execute` Phase 3 3-strike rule** (surfaces in `/ac:execute` Phase 3, `execute.md:305-322`): verification fails 3 times and the user selects "Stop and Investigate" at the 3-strike gate. `/ac:work` reaction: append `- <ISO> halt execute-3-strike` to the audit log and stop with state retained at `execute_started`.

6. **Oracle REJECT after 1 retry** (surfaces in `/ac:execute` Phase 4 Oracle hook, `execute.md:357-372`): `ac:oracle` returns REJECT on the initial run and again after one fix-retry; the user selects "Stop and Investigate" at the Oracle Halt gate. `/ac:work` reaction: append `- <ISO> halt oracle-reject` to the audit log and stop with state retained at `execute_started`.

---

Note: the `--semi` gate (Phase 2c `AskUserQuestion` between `/ac:plan` return and `/ac:execute` invoke) is a separate user-controlled pause, not a halt event. It does not append a halt line to the audit log and the run can resume normally after the user confirms.
