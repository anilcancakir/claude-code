---
description: Execute an approved plan from `.ac/plans/<slug>.md`. Wave-by-wave parallel `ac:plan-worker` spawn with tier-aware model routing (quick→haiku, junior→sonnet, senior→opus), per-step done-when verification, tier escalation retry on UNMET, wisdom accumulation across waves, complexity-gated post-execution review (`ac:plan-code-review` for Standard, `ac:plan-code-deep-review` for Complex), 3-strike halt rule, and `/ac:commit` handoff. Use after `/ac:plan` approves a plan. Accepts `--loop` for auto-mode.
argument-hint: <plan-slug | .ac/plans/path.md> [--loop]
effort: medium
---

# /ac:execute

Execute an approved plan from `.ac/plans/<slug>.md` with wave-by-wave parallel `ac:plan-worker` spawn, tier escalation retry, and complexity-gated verification.

Plan identifier: $ARGUMENTS

The plan is already approved by `/ac:plan`; execute directly. Do NOT call `EnterPlanMode`; the planning workflow finished before this command fires.

## Phase 0: Identity and Capabilities

You are the Developer orchestrating execution of an approved plan. You spawn `ac:plan-worker` subagents per step (parallel within waves), track progress via `TaskCreate` / `TaskUpdate`, accumulate wisdom across waves, and run complexity-gated verification before commit.

**CAN**: Full codebase access (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `LSP`). Spawn `Agent` with `subagent_type` `ac:plan-worker`, `ac:plan-code-review`, `ac:plan-code-deep-review`, `ac:linter`. Invoke `/ac:commit`. Run project build, test, and lint commands.

**CANNOT**: Modify the plan file (if the plan is wrong, report and stop). Skip verification before commit. Add new dependencies the plan did not authorize. Merge to the default branch without explicit user instruction.

**MUST**: Track via `TaskCreate` / `TaskUpdate` after every state change. Persist wisdom to `.ac/plans/<slug>.wisdom.md`. Check `<new-diagnostics>` after every worker returns; fix ERROR-severity findings before marking the step verified. Run linter advisory per step (not batched).

## Phase 1: Load Plan

**Goal**: Parse the plan and prepare execution context.

**Actions**:

1. **Resolve $ARGUMENTS to plan path**:
   - Strip `--loop` flag if present; store `LOOP_MODE = true | false`.
   - Strip `--oracle-final` flag if present; store `ORACLE_FINAL = true | false`.
   - Strip `--no-checkpoint-commits` flag if present; store `NO_CHECKPOINT_COMMITS = true | false`.
   - If the remaining argument contains `/` or starts with `.ac/`, treat it as the full path.
   - Otherwise treat it as a slug: `.ac/plans/<slug>.md`.
   - If the file is missing, inform the user (`Plan not found. Run /ac:plan <topic> first.`) and stop.

2. **Read the plan file. Parse**:
   - `**Complexity**:` → `PLAN_COMPLEXITY` (simple | standard | complex)
   - `**Codebase State**:` → `CODEBASE_STATE` (disciplined | transitional | legacy | chaotic)
   - Each `**Step N**:` block: title, description, files, done-when, QA, tier (`quick | junior | senior`), type (`code | infra`), wave assignment.
   - `### Wave N` sections for grouping.
   - `### Must NOT Have` section → `MUST_NOT_HAVE`.
   - `### Conventions` section → `PLAN_CONVENTIONS`.
   - `### Final Verification Wave` section → `FINAL_TASKS` (F1, F2, F3, F4).
   - `### Risks` section for awareness.

3. **Extract RUNTIME_CONTEXT**: read `CLAUDE.md` and `CLAUDE.local.md` if present, extract build / test / lint commands only. Workers receive full CLAUDE.md automatically; `RUNTIME_CONTEXT` supplements with explicit commands for the worker's verification step.

4. **Tier-to-model mapping**:
   - `quick` → `haiku`
   - `junior` → `sonnet`
   - `senior` → `opus`

5. **Codebase state escalation**: if `CODEBASE_STATE` is `chaotic` or `legacy`, escalate all `quick` steps to `junior` in-memory. The plan file is not modified; the escalation is for model routing only.

6. **Initialize state**:
   - `ACCUMULATED_WISDOM = []` (max 15 items total, max 5 per wave).
   - `VERIFY_RETRY_COUNT = 0` (for the 3-strike rule in Phase 3).
   - `MODIFIED_FILES = []` (tracked across waves for the post-execution review).

7. **Create CC tasks**: call `TaskCreate` once with one task per plan step plus tasks for F1-F4 in the final wave.

## Phase 2: Execute

**Goal**: Run wave-by-wave with parallel `ac:plan-worker` spawn per step.

### 2a. Present Execution Strategy

Display the wave breakdown:

```
## Execution Strategy

Plan: <name>
Total steps: <N> | Waves: <N>
Complexity: <PLAN_COMPLEXITY> | Codebase: <CODEBASE_STATE>

Wave 1 (parallel):
- Step 1: <title> [<tier>] <files>
- Step 2: <title> [<tier>] <files>

Wave 2 (after Wave 1):
- Step 3: <title> [<tier>] depends on Steps 1, 2

Wave FINAL: F1 Compliance, F2 Simplify, F3 QA, F4 Scope Fidelity
```

If `LOOP_MODE = true`, proceed without prompting. Otherwise call `AskUserQuestion`:
- Header: "Execute?"
- Options: "Execute (Recommended)" | "Adjust waves" | "Cancel"

### 2b. Launch Workers (parallel per wave)

For each wave in sequence:

For each step in the wave, in a single message block (parallel):

- Spawn `Agent({subagent_type: "ac:plan-worker", model: <tier_model>, run_in_background: true, description: "<step title>", prompt: <briefing>})`.
- Update each step's task to `in_progress` via `TaskUpdate`.

`<tier_model>` resolves from the step's `Tier:` per the mapping in Phase 1 step 4, with codebase state escalation applied.

> **Verbatim discipline (load-bearing)**: when constructing the worker briefing below, copy the plan's `Description`, `Done when`, `QA`, and `Must NOT` fields **verbatim** from the plan file. Do NOT paraphrase, summarize, or restate in your own words. Paraphrase produces silent semantic inversions (e.g., flipping a default opt-in/opt-out). If a field is too long to inline, copy the full block. This is the most common worker-prompt failure mode and F1 catches it as a plan-compliance violation; preventing it here saves a revision loop.

**Code-step briefing format**:

```markdown
## Task

Overall Goal: <plan title, 1-2 sentences>
Your Assignment: <step title>
<full step Description, verbatim from plan>

## Expected Outcome

Files to Modify: <paths from plan, verbatim>
Acceptance Criteria: <Done when block, verbatim from plan>
QA: <QA block, verbatim from plan>

## Must Do

- Follow CLAUDE.md conventions (already in your context) plus the plan conventions below.
- Follow the user's personal coding skill `my-coding` (preloaded into your context as initial messages). Apply its rules to every file you touch, not only the first. When `my-coding` and the plan conventions conflict, prefer `my-coding` and note the conflict in the Issues section of your report.
- <PLAN_CONVENTIONS, plan-specific only; do NOT duplicate generic coding rules already in CLAUDE.md>
- Read existing files before modifying; understand context.
- Implement the assigned step exactly, then run verification.
- If tests fail, fix the root cause. Do not skip tests or modify them to pass.

## Must NOT Do

Stay in scope: no out-of-scope files, no bonus refactors, no annotations on unchanged code.
<step's `Must NOT` field verbatim from plan>

[If RUNTIME_CONTEXT non-empty:]
## Build/Test Commands
<RUNTIME_CONTEXT>

[If ACCUMULATED_WISDOM non-empty:]
## Wisdom from prior steps
Prefer these over re-discovering:
<ACCUMULATED_WISDOM>

## Constraints

- Scope: the files and changes described above, nothing else.
- No new dependencies unless the step explicitly requires them.
- No modifications to files outside the assignment.

## Output Format

### Changes Made
- `file:line`: <what changed>

### Verification
- Build: <command> → <PASS or FAIL>
- Tests: <command> → <N pass, N fail>
- Lint: <command> → <PASS or FAIL>

### Issues (omit if none)
- <description>
```

**Infra-step briefing format** (steps with `Type: infra`): same template, swap "Files to Modify" for "Target" (SSH connection string from plan) and "Commands" (commands from the plan step). Worker uses Bash with SSH to execute.

**Spawn retry logging**: every worker spawn attempt (success or transient failure such as internal-error responses) appends to `.ac/plans/<slug>.wisdom.md` under an H3 "Wave N Worker Attempts" section:
```
- Step N (tier=<tier>, model=<model>): attempt 1 <success | failed: <reason>, retrying>, attempt 2 <...>
```
This pairs with the per-step `Done when` verification log so a retroactive read of the wisdom file reconstructs the full execution.

### 2c. Wave Barrier

Wait for ALL workers in the wave to return. All steps must reach a terminal verification state (verified or failed-after-retry) before the next wave launches.

### 2d. Per-Step Verification

For each completed worker:

1. **Check done-when**: parse the step's `Done when:` field.
   - File-content check: Read target, grep for the pattern.
   - Count-based check: run the check, compare.
   - Record `MET` (with `file:line` evidence) or `UNMET` (expected vs found).

2. **MET** → mark verified, proceed to diagnostics.

3. **UNMET** → tier escalation retry (max 1 per step):
   - `quick` retry with `sonnet` (`junior` tier).
   - `junior` retry with `opus` (`senior` tier).
   - `senior` no escalation, mark `failed`.
   - Pass failure context to the retry prompt: `Previous attempt UNMET: <criterion>. Expected <X>, found <Y>. Fix this specific issue.`
   - Retry `MET` → verified. Retry `UNMET` → `failed`, log for Phase 3.

4. **Diagnostics**: check `<new-diagnostics>` on modified files.
   - `ERROR` severity → halt this step, spawn a fix retry or escalate to user.
   - `WARNING` severity → log under Issues, continue.

5. **Linter advisory**: if LSP is available, spawn `Agent({subagent_type: "ac:linter", prompt: "Verify <files> after <step>."})`. Per step, NOT batched to the post-wave testing.

6. **Update task**: `TaskUpdate({status: "completed"})` for verified steps. Failed steps get a descriptive status update.

7. **Track modified files**: append to `MODIFIED_FILES` for Phase 3 review.

### 2e. Wisdom Extraction

After verifying all steps in the wave:

1. Extract actionable patterns from worker outputs: naming conventions, dependency-injection style, file organization, gotchas, error patterns.
2. Append to `ACCUMULATED_WISDOM` (max 5 items per wave, max 15 total). Skip generic statements; only actionable conventions.
3. Persist to `.ac/plans/<slug>.wisdom.md` (bullet list with wave / step annotations). Overwrite on each update.

### 2f. Post-Wave Testing

Run the project test suite for affected files. If tests fail:

1. Identify which step caused failure.
2. Attempt a targeted fix (Read error, fix specific issue, re-run).
3. If the fix fails, log as a failed step.

### 2g. Track Progress

After each wave completes, render the status table:

```
| # | Step | Wave | Tier | Verify | Result |
|---|------|------|------|--------|--------|
| 1 | <title> | 1 | junior | MET | <files changed> |
| 2 | <title> | 1 | quick | UNMET→MET (escalated) | <files> |
| 3 | <title> | 2 | senior | (waiting) | (pending) |
```

Repeat for each wave.

### 2h. Wave Checkpoint Commit (Complex plans only)

**Goal**: Keep granular rollback available across long Complex executions by committing each verified wave separately.

When `PLAN_COMPLEXITY === "complex"`, after 2g prints the per-wave status table and before the next wave launches:

- If `NO_CHECKPOINT_COMMITS === true`: skip the commit and add a one-line note to the wave summary -- `Wave <N> checkpoint commit skipped (--no-checkpoint-commits).` -- so the skip is visible in the log.
- Otherwise: invoke `/ac:commit --skip-preflight --no-push` via the `Skill` tool. `--skip-preflight` because per-step verification already ran in 2d; `--no-push` because the final push happens once in Phase 4 after the Final Verification Wave settles.

Apply this gate to every wave in sequence, not only the first.

Skip the checkpoint entirely when:
- `PLAN_COMPLEXITY` is `simple` or `standard` (per-wave commits add history noise; the single commit in Phase 4 covers the substance cleanly).
- The wave changed no tracked files (the `ac:git-master` skill detects a clean tree on its own and exits without creating a commit; this is a no-op, not an error).

The checkpoint runs inside the per-wave loop alongside 2b-2g; only 2i (Run Final Verification Wave) is outside the loop.

### 2i. Run Final Verification Wave (F1-F4)

After all implementation waves complete, run F1-F4 from the plan's `### Final Verification Wave` section. These run in parallel (file-exclusive, all read-only reviews):

- **F1**: Plan Compliance Audit. Spawn `ac:plan-code-review` (Standard plans) or `ac:plan-code-deep-review` (Complex plans) with prompt referencing plan path and `MODIFIED_FILES`.
- **F2**: Simplify Pass. Spawn `ac:plan-worker` with model `sonnet`, briefing it to run three parallel reviews against `git diff` (Code Reuse + Quality + Efficiency per `/simplify` pattern), aggregate findings, fix each directly, skip false positives silently. Tell the worker that the Quality review uses `my-coding` (preloaded into its context) as the quality baseline rather than generic best-practice lists; cite the specific `my-coding` rule for every fix.
- **F3**: Real Manual QA. Spawn `ac:plan-worker` with model `sonnet`, briefing it to execute every step's `QA:` scenario using the specified tool and capture evidence to `.ac/plans/<slug>.evidence/`. Acceptance criteria prefixed with `[MANUAL]` (per plan-prometheus convention) are NOT automated; the worker writes a `.ac/plans/<slug>.evidence/<ac-id>-manual.md` stub describing how a human would verify and marks the AC as pending-manual. The orchestrator surfaces the list of `[MANUAL]` ACs to the user in Phase 4 deliver.
- **F4**: Scope Fidelity Check. Spawn `ac:plan-worker` with model `opus`, briefing it to compare each step's Description against `git diff` in its Files list, flag scope creep and unaccounted changes.

Aggregate verdicts:
- All F-tasks pass / APPROVED → proceed to Phase 3.
- Any F-task BLOCKED → halt, surface findings, `AskUserQuestion`:
  - Options: "Fix and re-run F-tasks" | "Accept findings and continue" | "Stop and investigate".

## Phase 3: Verify (Complexity-Gated)

**Goal**: Run the final review based on `PLAN_COMPLEXITY`.

### Simple

Run build + test + lint. All pass → Phase 4. Any failure → fix and re-run.

No verification agent for Simple plans (F1-F4 above already covered the substance).

### Standard

Run build + test + lint. Then spawn:

```
Agent({
  subagent_type: "ac:plan-code-review",
  description: "Review <plan slug>",
  prompt: "Review the implementation against the plan at .ac/plans/<slug>.md. Modified files: <list>. Plan conventions: <PLAN_CONVENTIONS>. Your context has `my-coding` preloaded; treat its rules as the user-style baseline and flag every violation on the modified files, citing the specific rule and `file_path:line_number`."
})
```

Verdict `APPROVED` → Phase 4. `BLOCKED` → fix the cited issues, re-spawn the review (revision loop max 3 iterations).

### Complex

Run build + test + lint. Then spawn:

```
Agent({
  subagent_type: "ac:plan-code-deep-review",
  description: "Deep review <plan slug>",
  prompt: "Deep review. Plan: .ac/plans/<slug>.md. Modified files: <list>. Conventions: <PLAN_CONVENTIONS>. Your context has `my-coding` preloaded; treat its rules as the user-style baseline and flag every violation on the modified files, citing the specific rule and `file_path:line_number`."
})
```

Verdict `APPROVED` → Phase 4. `BLOCKED` → fix the cited issues, re-spawn the review (revision loop max 3 iterations).

### 3-Strike Rule

After 3 total verification failures (`VERIFY_RETRY_COUNT >= 3`):

```
AskUserQuestion({
  header: "Halted",
  question: "Verification has failed 3 times. Pipeline halted per 3-strike rule.",
  options: [
    {label: "Accept and Commit", description: "Acknowledge failures, invoke /ac:commit for current state."},
    {label: "Stop and Investigate", description: "Halt execution. Investigate the failing area manually."}
  ]
})
```

While `VERIFY_RETRY_COUNT < 3`:

```
AskUserQuestion({
  header: "Re-verify?",
  question: "Verification found issues (attempt <N>/3). How to proceed?",
  options: [
    {label: "Fix and Re-verify (Recommended)", description: "Address failures, re-run verification."},
    {label: "Accept and Commit", description: "Acknowledge failures, commit current state."}
  ]
})
```

Increment `VERIFY_RETRY_COUNT` on each loop entry.

## Phase 4: Deliver

**Goal**: Commit, save memory, generate the dev report.

**Actions**:

1. **Oracle final review** (gate: `ORACLE_FINAL === true && PLAN_COMPLEXITY === "simple"`).

   If the gate is false, skip to Action 2.

   Spawn:

   ```
   Agent({
     subagent_type: "ac:oracle",
     description: "Oracle final review <plan slug>",
     prompt: "Self-review category. Plan: .ac/plans/<slug>.md. Modified files: <MODIFIED_FILES>. Conventions: <PLAN_CONVENTIONS>. Verify the implementation skeptically: are there bugs, missing edge cases, unhandled errors, or scope drift that the F1-F4 execution wave might have missed? Return a clear VERIFIED or REJECT verdict. On VERIFIED, state what you checked and why the implementation is sound. On REJECT, list each issue with file_path:line_number so the orchestrator can fix them before committing."
   })
   ```

   - On `VERIFIED`: proceed to Action 2.
   - On `REJECT` (first): fix every cited issue in the orchestrator's flow, then re-spawn `ac:oracle` once with the same prompt. Note: any persistent `oracle_attempts` counter lives in the caller's state file (e.g., `/ac:work`'s `.ac/work/<work-slug>.state.md`); `/ac:execute` reports the outcome and the caller updates state. `/ac:execute` does not write to caller state files.
     - On `VERIFIED` after retry: proceed to Action 2.
     - On `REJECT` after retry: halt via:

       ```
       AskUserQuestion({
         header: "Oracle Halt",
         question: "Oracle rejected the implementation twice. Findings: <oracle rejection summary>. How to proceed?",
         options: [
           {label: "Accept findings and commit", description: "Acknowledge the rejection, invoke /ac:commit for current state."},
           {label: "Stop and Investigate", description: "Halt execution. Investigate the failing area manually."}
         ]
       })
       ```

       If the user selects "Accept findings and commit", proceed to Action 2. If "Stop and Investigate", halt.

2. **Final commit**: if `NO_CHECKPOINT_COMMITS === true`, skip this Action entirely (the caller, typically `/ac:work --no-commit`, owns the commit policy). Otherwise invoke `/ac:commit --skip-preflight` to commit all changes.

3. Save up to 2 workflow memories capturing significant decisions or patterns from this plan execution (architecture decisions, root causes, codebase-evolution notes). Show a brief summary of what was saved, or skip silently if nothing warrants saving.

4. Generate a dev report to `.ac/plans/<slug>.report.md`:

```markdown
## Summary
<1-2 sentence overview>

## Changes Made
- `file/path:line`: <what changed and why>

## Tests
- <test command>: <result>

## Execution Stats
- Complexity: <level> | Waves: <completed>/<total> | Steps: <completed>/<total>
- Tiers: <N> quick, <N> junior, <N> senior | Escalations: <N>
- Verification: code-review <APPROVED | N/A>, deep-code-review <APPROVED | N/A>

## Notes
- <accumulated wisdom, non-obvious decisions, open questions>
```

**Verify the Write landed**: immediately after the `Write` call, run `Bash test -f .ac/plans/<slug>.report.md && wc -l .ac/plans/<slug>.report.md` (or equivalent `Glob`). If the file is absent or zero-length, the `Write` tool likely returned an internal error silently; retry the Write once. If the second attempt also fails, surface to the user with the report content rendered inline so it is not lost.

5. Render the execution summary to the user:

```
## Execution Complete

Plan: <name>
Steps: <N>/<N> completed
Complexity: <level>

Verification Results:
- F1 Compliance: <APPROVED | BLOCKED>
- F2 Simplify: <APPROVED | BLOCKED>
- F3 QA: <APPROVED | BLOCKED>
- F4 Scope Fidelity: <APPROVED | BLOCKED>
- Code Review: <APPROVED | N/A>
- Deep Code Review: <APPROVED | N/A>

Pending Manual Verification (if any `[MANUAL]` ACs exist):
- <ac-id>: <one-line what to verify, with link to .ac/plans/<slug>.evidence/<ac-id>-manual.md>

Next Up:
<If LOOP_MODE: "Proceeding to next phase automatically.">
<If standalone: "Changes committed.">
```

Omit the "Pending Manual Verification" section when no `[MANUAL]` ACs exist in the plan. When present, the user receives a checklist so manual verification is not silently forgotten.

## Error Handling

- **Worker returns incomplete output**: re-read the files the worker was supposed to change. If changes exist, verify manually and continue. If not, treat as failed step.
- **Wave has mixed results**: continue to the next wave only if failed steps are NOT dependencies for the next wave. If they are, halt and report.
- **Test suite fails after all waves**: isolate which wave introduced failure. Attempt a targeted fix. If 3 attempts fail, invoke the 3-strike rule.
- **Plan is unexecutable** (wrong file paths, impossible requirements): do NOT improvise. Report the issue, stop, suggest `/ac:plan` revision.
- **Plan file not found**: inform the user, suggest `/ac:plan <topic>` first.
- **No independent steps found**: fall back to sequential execution (one step per wave).

## Verification Depth Summary

| Complexity | Per-wave | Final Verification Wave | Post-execute review |
|---|---|---|---|
| Simple | plan-worker | F1+F3 (F2/F4 optional) | build + test + lint |
| Standard | plan-worker | F1-F4 | `ac:plan-code-review` (3-stage) |
| Complex | plan-worker | F1-F4 | `ac:plan-code-deep-review` (4-stage including cross-layer) |
