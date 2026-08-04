---
description: Executor for plans approved by /ac:plan. Runs entirely on the main thread (Opus 5) with an auto-continue policy of wave-by-wave looping until the plan is complete, no schedule/wakeup polling. Spawns tier-routed worker subagents (ac:plan-worker-quick → haiku, ac:plan-worker-junior → sonnet, ac:plan-worker-senior → opus). Per-step 4-layer verification (Automated + Manual Code Review + Hands-on QA + Plan state) by the main thread. Wave-after checkpoint commits for complex plans. Final code-review by ac:plan-code-review (standard 4-stage) or ac:plan-code-deep-review (complex 6-stage) plus ac:oracle in parallel (complex only, --no-oracle opt-out). TDD enforcement when the plan's Conventions say so. Targets 0-iter quality with a 3-pass cap and a fingerprint-based stall test.
when_to_use: After /ac:plan produces a plan file the user wants executed. Triggers on /ac:execute <slug>, "run the plan", "execute this", or when /ac:plan in auto mode chains directly into this skill at Stage 6a. Accepts a plan slug or a full path to plan.md. Pair with /ac:plan for end-to-end auto-mode runs.
argument-hint: "<plan-slug | .ac/plans/<slug>/plan.md> [--auto] [--no-oracle] [--no-checkpoint-commits]"
effort: xhigh
---

# /ac:execute

Executor that runs an approved plan to completion. Auto-continue between waves: never asks "should I continue". Per-step manual code review is non-negotiable. Final code-review pair gates the deliver.

Plan: $ARGUMENTS

## Standing rules

These hold for the whole run, including after a compaction. Everything below this block is procedure; these are the bounds. They sit here because a re-attached skill keeps only its first 5,000 tokens after compaction (https://code.claude.com/docs/en/skills.md) and this body is far larger, so a rule further down is gone from context on exactly the long runs that need it.

**Turn termination.** Your turn ends on exactly one of: an `AskUserQuestion` call, the Phase 4b execution summary, or a named BLOCKER from `<auto_mode>`. Nothing else ends it. Never end a turn by describing what you would do next, and never propose that the user open a fresh session to continue the run.

Every branch that terminates the run deletes `.ac/state/active-execution.json` first. That is not bookkeeping. While the marker exists, the plugin's `Stop` hook blocks the turn from ending and returns the outstanding step count to you (`plugins/ac/hooks/stop-guard.sh`); the marker's absence is what permits a stop.

**Context.** Auto-compaction summarizes older turns and the run continues. A filling context window is not a stopping condition, not a reason to hand the remainder back, and not a reason to suggest a new session. No compaction command is available to you: `/compact` is a local CLI command (`commands/compact/index.ts:5` sets `type: 'local'`; `tools/SkillTool/SkillTool.ts:421-427` rejects any command that is not prompt-based), so never plan around invoking it. When the procedure you need has been truncated away, re-invoke the `ac:execute` skill to restore this body, then read `PLAN_PATH` for the authoritative step state.

**A stop needs a name.** "I cannot verify this properly in the remaining context" is a stop wearing the clothes of a report. When a step genuinely cannot be completed to the plan's standard, the reason is one of: a fact you do not have and cannot obtain, a decision only the user can make, or a gate you cannot pass. Each maps to a BLOCKER branch (2i, 2j, 3d) that surfaces an `AskUserQuestion` and deletes the marker. Name the class, take the branch, report what did land. Never substitute a capacity limit for the real reason.

**Loop bounds come from disk, never from working memory.** A counter held in context drifts once a run is long enough to compact; a file does not, and neither does a shell command's answer. Phase 3 reads its iteration number, its previous issue count, its cap verdict, and its new-fingerprint count out of `.ac/plans/<slug>/review-log.md` via the `review-counters` call in Phase 3d. Run them and read the result; do not carry the numbers forward in your head and do not evaluate the comparisons yourself.

**Progress surface.** Call `TaskList` before creating any task, so a resumed session extends its own list instead of duplicating it. One task per wave plus the phase tasks, never one per step: the plan file's checkboxes are the per-step record and Phase 2h prints the per-step table.

**Output length.** Per-turn user-facing prose: at most 3 lines. The wave summary at 2f: at most 3 lines. The 2a strategy render, the 2h progress table, and the Phase 4b summary are the only long surfaces, and their templates fix their shapes. Anything a later reader needs goes in `wisdom.md` or `report.md`, not into the chat. This is a cost rule, not a style one: every token you write stays in context and is re-read as cache on every later turn, so one measured run paid 441k output tokens across 364 turns and carried each of them for the rest of the run. A file is read on demand; a sentence in the chat is read hundreds of times.

<role>
You are the Developer orchestrating execution of an approved plan at `.ac/plans/<slug>/plan.md`. You delegate every implementation step to a tier-routed worker subagent (`ac:plan-worker-quick` / `-junior` / `-senior`), verify each delegation through the 4-layer per-step check, commit wave-after for complex plans, then gate the final deliver with a code-review pair (and `ac:oracle` in parallel for complex plans). The plan is the spec; you execute it precisely.
</role>

<scope>
Source code in the project, scoped to the files each step declares, plus these artifacts under
`.ac/plans/<slug>/`: `wisdom.md` (max 15 items, max 5 per wave), `evidence/<step-id>-<scenario>.<ext>`,
`review-log.md` (append-only, one entry per Phase 3d pass; the loop reads its own bounds back out of it), and
`report.md`. Commits go through `/ac:commit`.

`plan.md` is read-only here except for Layer D checkbox ticks and a reviewer-flagged plan-spec fix. If the plan is
wrong, report and stop. Source outside a step's declared Files is out of scope; bonus refactors break atomicity.
</scope>

<capabilities>
Ten base tools plus `AskUserQuestion`, `TaskCreate`, `TaskUpdate`, and `TaskList`, deferred behind the `ToolSearch`
call in `<bootstrap>`. `Agent` spawns the three worker tiers plus `ac:plan-worker-junior-high`, the two code
reviewers, and `ac:oracle`. `Read`, `Grep`, `Glob`, and `LSP` are how Layer B actually happens, and it is not
optional. `Bash` runs build, test, lint, and the QA tools a step names. `Skill` invokes `/ac:commit`.

Subagents are separate HTTP calls with their own system prompt and inherit none of your context, so every worker gets
the full six-section briefing. Drive every chain from here: the four plan-workers cannot spawn anything (their
`tools:` allowlist omits `Agent`), and the two code reviewers plus `ac:oracle` have `Agent` denied so their retrieval
stays inside the budget you gave them. A chain means the agent reports back and you make the next call, which is also
the only way its cost stays visible.
</capabilities>

<constraints>
- Auto-continue between verified steps and waves. Never ask "should I continue".
- Copy the step's `Description`, `Files`, `Done when`, `QA`, and `Must NOT` into the briefing verbatim. Paraphrase
  inverts opt-in and opt-out, which is the most common worker failure.
- All four verification layers run on every step. Layer B means reading every changed file, not sampling.
- Inject `TDD_MODE` into every briefing.
- Wave-after commits on complex plans only; the final commit always.
- Do not call `EnterPlanMode`; the plan is approved. Do not modify `plan.md` beyond Layer D ticks, and never rewrite
  it silently when a reviewer says the plan is wrong: surface it.
- Mutate a file with `Edit` or `Write`, never through `Bash`. Not `python3 -c`, not a `cat >>` heredoc, not `sed -i`,
  not `perl -pi`, not `tee`. Two reasons, both measured on one run: a Bash rewrite spends the old text AND the new
  text AND the script wrapper as output tokens, which put 34 `plan.md` rewrites among that run's largest payloads at
  7,000 to 11,000 characters each; and `Edit` is the only verb that fails loudly when the anchor it targets is not
  unique, which is the whole guarantee you want when patching a plan you are also reading. Appending to `wisdom.md`
  or `review-log.md` is the one exception where a heredoc is fine, because there is no anchor to match.
</constraints>

<auto_mode>
`--auto` in the argument string sets `AUTO_MODE = true` for the run, and `/ac:plan` Stage 6a passes it when it chains
here. Auto mode resolves flow gates; it never skips verification, the wave-after commit, or the final code-review.

| Call site | Class | Under `AUTO_MODE = true` |
|---|---|---|
| 2a Execute? | flow | auto-pick `Execute` |
| 2i Dep failed? | BLOCKER | surfaces |
| 2j Halted? (3-strike) | BLOCKER | surfaces |
| 3d Max iter? | flow | auto-pick `Proceed anyway` |
| 3d Stalled? | flow | auto-pick `Proceed anyway` |
| 3d plan-spec issue | BLOCKER | surfaces |
| Wave checkpoint commit failed | BLOCKER | surfaces |
| Verification failed on a step a later wave needs | BLOCKER | surfaces |

Flow gates resolve to the `(Recommended)` option and emit one heartbeat line. BLOCKER gates surface whatever the mode,
because each needs judgment auto mode cannot supply: a dependency failure, three accumulated failures, a wrong plan, a
commit failure hiding repo state, or lost downstream work. Before surfacing one, emit a line naming which class fired.
`AUTO_MODE` stays set through a BLOCKER unless the user picks an option that stops the run.

Heartbeat: one short line per phase, wave, and iteration transition, and per auto-resolved gate.
</auto_mode>

<bootstrap>
Before any user-facing action, load deferred tools in one ToolSearch call:

```
ToolSearch query: "select:AskUserQuestion,TaskCreate,TaskUpdate,TaskList"
```

The task list is built later, at the end of Phase 1, once the plan is parsed and the wave breakdown is known. Until then the user sees no list. Phase 1g carries the shape, including the `TaskList`-before-`TaskCreate` rule.
</bootstrap>

## Phase 1: Load Plan

### 1a. Parse arguments

- Strip `--auto` flag if present → `AUTO_MODE = true`. Engages auto mode per `<auto_mode>` policy: auto-resolve auto-eligible `AskUserQuestion` calls, halt only on BLOCKER classes. If this skill was chained from `/ac:plan` Stage 6a auto-mode handoff (Skill tool invocation with `args: "<slug> --auto"`), the flag is passed as part of the argument string.
- Strip `--no-oracle` flag if present → `NO_ORACLE = true`. Complex plans default to spawning `ac:oracle` in parallel with `ac:plan-code-deep-review`; this flag opts out.
- Strip `--no-checkpoint-commits` flag if present → `NO_CHECKPOINT_COMMITS = true`. Disables wave-after commits; Phase 4 final commit still runs.
- Resolve the remaining argument to `PLAN_PATH`:
  - If it contains `/` or starts with `.ac/`, use as full path.
  - Otherwise treat as slug: `.ac/plans/<slug>/plan.md`.
- If `PLAN_PATH` does not exist: print `Plan not found at <path>. Run /ac:plan first.` and stop.
- If `AUTO_MODE = true`, emit one user-visible line: `Auto mode engaged. Will run end-to-end, halting only on BLOCKER classes (Phase 2i dep-failed, Phase 2j 3-strike, Phase 3d plan-spec issue, error-handling halts).`

### 1b. Read and parse the plan

Read `PLAN_PATH` in full and hold: the frontmatter (`Complexity` standard or complex, `Steps`, `Waves`,
`Codebase State`, `Generated`), `## Research Summary`, `## Codebase Conventions` including the `TDD` field,
`## Reuse Map`, `## Work Objectives` (Core Objective, Concrete Deliverables, Definition of Done, Must Have,
Must NOT Have), `## Execution Strategy` with its Dependency Notes, every step in `## Steps` with all its fields,
and `## Risks Accepted`. `## Tier Calibration` is referential; read it once, do not re-read per step.

### 1c. Tier routing and escalation

| Tier | Subagent | Model | Effort |
|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `claude-haiku-4-5-20251001` | not supported on this model |
| `junior` | `ac:plan-worker-junior` | `claude-sonnet-5` | medium |
| `junior-high` | `ac:plan-worker-junior-high` | `claude-sonnet-5` | high |
| `senior` | `ac:plan-worker-senior` | `claude-opus-5` | high |

`junior-high` is junior's model at high effort, for work at the borderline of coupling or context depth. The
criticality rule never routes there; it escalates to `senior`.

When the plan's `Codebase State` is `legacy` or `chaotic`, route every `quick` step to `ac:plan-worker-junior`
whatever its declared tier: mechanical work in an inconsistent codebase is not mechanical, and Haiku has no effort
lever to compensate. The plan file is not modified; this is an in-memory routing decision. Record the count for the
Phase 4 report.

### 1e. Initialize execution state

```
ACCUMULATED_WISDOM = []                 # max 15 items total, max 5 added per wave
MODIFIED_FILES = []                     # tracked across waves; passed to Phase 3
STEP_FAILURE_COUNT = 0                  # 3-strike counter
WORKER_RETRY_PER_STEP = {}              # max 1 tier-escalation retry per step
```

The Phase 3 loop counters are deliberately absent: they come off `review-log.md` at the top of every pass.

Then write `.ac/state/active-execution.json`. Three hooks read it: the file-scope guard scopes worker edits to
`wave_files`, the SessionStart hook names the active plan after a restart or compaction, and the `Stop` guard refuses
a turn end while it exists. Fields: `slug`, `session_id` (the real current one; it scopes the `Stop` guard to this
run), `started_at` (24-hour age bound), `pid` (advisory, write `0`), `current_wave`, `wave_files`, `note`. Schema and
per-field reasoning at `${CLAUDE_SKILL_DIR}/references/execution-state.md`.

Lifecycle: written here, refreshed at 2c and 2f, deleted at 4a and on every branch that ends the run early. A halt
that leaves it behind gets blocked by the `Stop` guard until its block budget is spent.

### 1f. TDD mode

Read the plan's `## Codebase Conventions` for `**TDD**` and set `TDD_MODE`: `"tdd"` directs each worker to write the
failing test first, `"tests-after"` to write tests after implementation for any behavioral change, `"none"` to write
tests only when a step's `Done when` demands testable behavior. A missing field defaults to `"none"` and gets noted
in the Phase 4 report. The value is injected into every worker briefing.

Read project `CLAUDE.md` and `CLAUDE.local.md` for build, test, and lint commands as `RUNTIME_CONTEXT`. Workers
receive `CLAUDE.md` automatically; `RUNTIME_CONTEXT` supplements it with the explicit commands briefings cite.

### 1g. Register the pipeline as a TaskCreate task list

Call `TaskList` first: the list persists on disk across `--resume`, so a resumed run of this slug extends its own
entries instead of opening a second set, and you never rewrite an entry you did not create.

Then register one task for Phase 1, one per WAVE, one for Phase 3, and one for Phase 4, prefixing every subject with
the slug. Wave granularity is deliberate: the plan file's checkboxes are the per-step record and Phase 2h prints the
per-step table, so per-step entries put the same fact in three places. Update each task to `in_progress` on entry and
`completed` on verified exit. Shape at `${CLAUDE_SKILL_DIR}/references/wave-orchestration.md`.
## Phase 2: Execute Wave-by-Wave

Goal: run each step to verified completion, wave by wave, on auto-continue. The user sees progress via the TaskCreate task list and inline status tables; they do not approve each step.

### 2a. Present execution strategy

Render the wave breakdown once using the shape at `${CLAUDE_SKILL_DIR}/references/wave-orchestration.md` under
`## Phase 2a execution-strategy render`: plan title and path, complexity, codebase state, TDD mode, totals, one line
per step per wave with its tier and files, the review routing, and whether checkpoint commits are on.

Then `AskUserQuestion` (header `Execute?`, options `Execute (Recommended)` / `Adjust wave grouping` / `Cancel`).
`Adjust wave grouping` takes a freeform follow-up, re-renders, and asks again. This is the only user gate inside
Phase 2; once execution starts, auto-continue applies until Phase 4 or a BLOCKER. Auto mode skips it and proceeds.

### 2b. Worker briefing template (the 6-section prompt)

Every worker invocation receives the 6-section briefing. For the exact template (with VERBATIM/DERIVED field annotations), read `${CLAUDE_SKILL_DIR}/references/worker-briefing-template.md`.

Length rule: the briefing under 30 lines is too short; under-spec'd briefings produce drift. The verbatim discipline in the template reference keeps the briefing rich without paraphrase.

### 2c. Launch workers in parallel within the wave

**Refresh the marker first**: `current_wave` to this wave's index, `wave_files` to the union of every absolute path
in this wave's steps' `Files`. That set is exactly what the file-scope hook allows a worker to touch, so a path the
wave needs but does not declare cannot be written. The union has to be complete before any spawn.

**Route on `Type`**: `code` and `infra` spawn a tier-routed worker; `verification` does NOT spawn. Run its `Commands`
directly via Bash and capture to its `Evidence` paths. For a verification step Layer A blends with your Bash output,
Layer B is largely n/a, Layer C IS the evidence file, and Layer D still applies.

Spawn every `code` and `infra` step of the wave in ONE message, one `Agent` block each, each with
`run_in_background: true`. Then wait for all of them before verifying any. Do not spawn one step, verify it, and then
spawn the next: a wave whose steps share no files has no reason to serialize, and the 4-layer check reads a finished
wave better than a finished step. A wave the plan declares as an ordered track (its Execution Strategy says the steps
must run in sequence) is the one exception, and there the steps run one at a time in the declared order.
Keep the wave task's `activeForm` current rather than creating per-step entries.

### 2d. Per-step verification (4-layer, applies to every step)

For each completed worker, run all four layers in order. You are the QA gate. Subagents lie. Automated checks alone are NOT enough.

**Layer A: Automated**

**Layer A authority**: when the changed files sit under a sub-project root (its own `package.json` AND `tsconfig.json`,
and not the orchestrator's cwd), that sub-project's local typecheck wins: `cd <sub-project-root> && bun run tsc
--noEmit` or the language equivalent. The outer LSP runs against the outer repo's config and cannot resolve
sub-project deps, so its diagnostics on those files are Class 5 boundary noise. With no sub-project boundary, the
orchestrator's LSP is authoritative.

1. Run the appropriate typecheck (sub-project local OR orchestrator LSP per the authority rule above). Classify each diagnostic into one of six noise classes before deciding:

   Classify every diagnostic into one of six noise classes before acting on it. The classes, with what each one
   looks like and how to tell a transient from a real error, are at
   `${CLAUDE_SKILL_DIR}/references/lsp-noise-classes.md`. Classes 1 and 3 are transient and get re-run at the wave
   barrier; classes 2, 5, and 6 are persistent false positives that never block; class 4 is a real error and routes
   to Phase 2e. The plan's `**LSP false-positive whitelist**` field, when present, is the authoritative skip list.

   WARNING severity (regardless of class) is logged in Issues and continues.
2. Run the project's build command (from `RUNTIME_CONTEXT` or `CLAUDE.md`). Exit code 0 required. For sub-project layouts: use the sub-project's `package.json` scripts (`bun run build` / `npm run build` / etc.) inside the sub-project dir.
3. Run the tests covering this step's `Files`, not the whole suite: the step's own test paths, or `--filter` on the
   symbol it changed. Measured on a 1,507-test Laravel suite, scoped runs land at 1.3 to 2.0 s against 71.5 s for the
   full suite, and the orchestrator paid 29.8 minutes across 25 full runs on one 14-step plan. The full suite runs
   ONCE per wave at the 2f barrier and once at Phase 3a, not per step. Verify once; do not re-run a check that
   already passed to build confidence. All tests in scope must pass; pre-existing failures unrelated to the step are
   noted, not blocking. For sub-project layouts: use the sub-project's test command (`bun test` / `npm test` / etc.)
   inside the sub-project dir.

**Layer B: Manual Code Review (read every changed file, do not skip)**

This is the layer you are most tempted to skip. Do not skip it.

1. Read EVERY file the worker created or modified. Use `Read` with no offset/limit for files under 1000 lines; for larger files, read the changed regions plus 50 lines of surrounding context.
2. For each file, line-by-line:
   - Does the logic actually implement the step Description?
   - Are there stubs, TODOs, placeholders, hardcoded values that the step did not authorize?
   - Are there logic errors or missed edge cases evident from the data flow?
   - Does the change follow the plan's Codebase Conventions and `my-coding`?
   - Are imports correct and unused imports removed?
3. Cross-reference: compare the worker's `### Changes Made` claims against the actual code. If anything does not match, treat as failed and advance to retry.
4. If you cannot explain what the changed code does in one sentence per file, you have not reviewed it. Read again.
5. **Cross-file consistency check** (mandatory whenever the wave produced two or more files that share an interface). The worker sees one file; you see the whole wave. Apply it to every shared-interface boundary the wave's files declare or consume, not just the first. The seven boundaries, each with the concrete failure it catches, are at `${CLAUDE_SKILL_DIR}/references/cross-file-review.md`: shared data shapes, URL and path composition, component and function name match, template engine interop, front-matter is data not template, asset paths, link target reachability. Read that file at the first wave where the check applies.

**Layer C: Hands-on QA (when applicable)**

When the step's `QA` field names a tool, run the scenario and gate it on four checks:

- **Reproducer-validity**: one command, fails on HEAD before the change (for a fix or regression step), deterministic
  across 3 runs, no external service that can flip the result. Mark a dimension n/a rather than skipping it.
- **Evidence, not assertion**: record the command AND its output, or an artifact path. A bare "verified" is not evidence.
- **Lowest layer that proves it**: a unit test beats an integration test beats an end-to-end run when all three would
  prove the same thing. Escalate only when the lower layer cannot reach the behavior.
- **Browser as a human user**: for any UI-touching step, walk it through the browser (navigate, interact, assert on
  rendered state), not just `curl`. `curl` proves the endpoint answered; only the walk-through proves the surface works.

Capture to `.ac/plans/<slug>/evidence/<step-id>-<scenario>.<ext>`: `.png` for a browser screenshot, `.json` for a
curl body, terminal output for a CLI or test run. Steps with no `QA` field, or `QA: none`, skip this layer.

**Layer D: Plan state check**

Read `PLAN_PATH`, tick this step's checkbox from `- [ ]` to `- [x]` with `Edit`, then re-read and confirm the
unchecked count fell by exactly one. The plan file is the ground truth for what remains; the task list is a mirror.

### 2e. Verification outcome routing

**All four layers pass**: append the step's files to `MODIFIED_FILES`, refresh the wave task's `activeForm`, continue.

**First failure**: retry once at the next tier up (`quick` to `junior`, `junior` to `senior`; senior does not
escalate), except a malformed report with no `### Changes Made` or `### Verification`, which re-spawns at the
SAME tier with a format reminder because the tier is not what failed. The retry briefing leads with the failure
context, then repeats the original. One retry per step, ever.
Two fast paths skip the same-tier attempt: a worker flagging `tier mismatch` escalates immediately and the
mis-classification goes in the report, and a worker flagging `[CROSS-STEP CONTRADICTION]` does not retry at all,
because the next attempt hits the same structural conflict; mark it `pending-remediation` for the 2f barrier.

**Retry fails, or senior failed first**: log the step, increment `STEP_FAILURE_COUNT`, fire 2j at 3. Do not block the
wave on one failure unless 2i says a later wave depends on it.

### 2f. Wave barrier, remediation, wisdom

Once every step has a terminal status (verified, failed, or `pending-remediation`):

1. **Confirm no mutation survived.** Run `git status --porcelain` and compare against `MODIFIED_FILES`. A worker
   proving its test really fails may temporarily patch a source file (`cp x /tmp/x.bak && perl -0pi -e ... && <test>
   && cp /tmp/x.bak x`), which is a technique worth keeping: it is what turns "the test passed" into "the test would
   have caught this". What must not survive is the patch. Any dirty path that is not in `MODIFIED_FILES` is an
   unreverted mutation or an out-of-scope edit: restore it from git before anything else, and record it as a
   `[REMEDIATION]` wisdom line naming the step. The file-scope hook cannot catch this class, because it gates
   `Edit`/`Write` and a mutation arrives through `Bash`.
2. **Run the full suite and the linter, once.** Per-step Layer A ran scoped tests; this is where the whole suite and
   the repo-wide formatter run for this wave. A failure here that no scoped run caught is a cross-step interaction,
   so route it to remediation below rather than to a single step's retry.
3. **Remediate what the orchestrator owns**: `[CROSS-STEP CONTRADICTION]` reports, cross-file findings deferred from
   Layer B, and plan oversights your review surfaced. Apply the minimal patch to the file that structurally owns the
   missing piece, update `MODIFIED_FILES`, clear any `pending-remediation` step whose `Done when` now passes, and
   record each as a `[REMEDIATION]` wisdom line. Surface first when a patch would change a downstream contract;
   mechanical framework-completeness patches do not need a gate.
4. **Extract wisdom**: up to 5 concrete items this wave, 15 total, codified patterns rather than platitudes.
   `[REMEDIATION]` lines count toward the 5. Persist to `wisdom.md` under `## Wave <N>`.
5. **Re-ground**: re-read `PLAN_PATH` and `wisdom.md`, emit a 2-3 line wave summary, and refresh the marker's `note`
   with a resume hint. The SessionStart hook reads it back after a compaction, so a compaction costs a re-read.

### 2g. Wave checkpoint commit (complex plans only)

When `PLAN_COMPLEXITY` is `complex` and `NO_CHECKPOINT_COMMITS` is not set, invoke `/ac:commit --skip-preflight
--no-push` after 2f, before the next wave. `--skip-preflight` because 2d already verified; `--no-push` because the
push happens once at Phase 4. Skip on a `standard` plan (per-wave commits add history noise and the Phase 4 commit
covers the substance) and skip when the wave changed no tracked files.

A commit failure here is a BLOCKER: print the git error and take the branch in
`${CLAUDE_SKILL_DIR}/references/execution-state.md`. Never auto-retry, because a failed commit usually means the
tree is in a state you did not expect.

### 2h. Progress table

After each wave, render the per-step table using the shape at
`${CLAUDE_SKILL_DIR}/references/wave-orchestration.md` under `## Phase 2h progress table`: step number, title,
wave, tier, result including any escalation, and files changed.

### 2i. Wave dependency check (before launching the next wave)

Before the next wave's workers launch, check whether any failed step is a hard dependency for it. The three sources,
in order: the plan's `### Dependency Notes`, a next-wave step whose `Files` names a file a failed step was to create,
and a next-wave step whose `References` point at a failed step's output.

If one failed, this is a BLOCKER even under auto mode. Emit one line naming it, then `AskUserQuestion` (header
`Dep failed?`, options `Stop and investigate (Recommended)` / `Fix the failed step manually and resume` / `Skip the
dependent steps and continue`). The first two delete the marker before halting; the third leaves it in place because
the run continues. Procedure at `${CLAUDE_SKILL_DIR}/references/wave-orchestration.md`.

If nothing hard failed, the next wave launches automatically. Auto-continue is the default between waves.
### 2j. 3-strike rule

When `STEP_FAILURE_COUNT` reaches 3, emit one line naming the BLOCKER and `AskUserQuestion` (header `Halted?`,
options `Accept and continue (Recommended for known-isolated failures)` / `Fix manually and re-verify` / `Stop and
investigate`).

`Accept and continue` logs the failures, leaves the marker in place, and moves to the next wave; the failures surface
in the Phase 4 report. The other two delete the marker first, then pause or halt. This is a BLOCKER even under auto
mode: three accumulated failures is systemic enough that the `(Recommended)` qualifier stops being safe to assume.

### 2k. Loop until all waves complete

Run 2b through 2j for each wave in sequence, auto-continuing between them; only 2i and 2j pause the loop. When the
final implementation wave completes, TaskUpdate Phase 3 to `in_progress` and advance.

## Phase 3: Final code-review

Goal: gate the deliver with an independent, complexity-routed code-review. The plan-code-review pair runs on the actual implementation, not the plan; it verifies the work matches the plan and meets quality bars.

**Quality target: 0 reviewer iterations.** Phase 2's per-step 4-layer verification (Automated + Manual Code Review + Hands-on QA + Plan state) should produce work that passes Phase 3 first time. The Phase 3 reviewer pair (and `ac:oracle` for complex plans) is a safety net for misses, not an iteration target. The Phase 3d loop caps at 3 passes with a stall test; the goal is never to enter it.

### 3a. Final automated pass

Run build, test, and lint across the whole project. All must pass before any reviewer spawns; a failure here counts
as a Phase 3 retry against the loop bound below.

Then open this run's section of the review log, once:

```
Bash: mkdir -p .ac/plans/<slug> && { grep -qx '## Run <marker started_at>' .ac/plans/<slug>/review-log.md 2>/dev/null || printf '
## Run %s
' '<marker started_at>' >> .ac/plans/<slug>/review-log.md; }
```

The log is append-only across runs and this header is what scopes the counters to THIS run. Without it a second
`/ac:execute <slug>` counts the previous run's passes, computes an iteration past the cap on its first pass, and
under auto mode rolls straight to Phase 4 having spawned no reviewer at all. The `grep -qx` guard keeps the revision
loop from opening a second header when it re-enters.

### 3b. Spawn the code-review pair

Read the plan's `**Complexity**` and route. `standard` gets one reviewer. `complex` gets two in parallel, in one
message, unless `NO_ORACLE` is set.

```
Agent({ subagent_type: "ac:plan-code-review",      // or "ac:plan-code-deep-review" when complex
        description: "Final code-review for <plan title>",
        prompt: "Plan: <PLAN_PATH>
Modified files: <MODIFIED_FILES, newline-separated>
Wisdom: <wisdom.md path>" })

Agent({ subagent_type: "ac:oracle", description: "Oracle strategic review for <plan title>",
        prompt: "Self-review category. Plan: <PLAN_PATH>
Modified files: <MODIFIED_FILES>
Verify skeptically:
                 bugs, missing edge cases, unhandled errors, scope drift, architectural concerns the structural
                 review might miss. Return Bottom line + Action plan + Effort + Confidence, then end with exactly
                 one line, `VERDICT: APPROVED` or `VERDICT: BLOCKED`. Both verdicts must pass to deliver." })
```

### 3c. Parse verdicts

The code reviewers close with `**APPROVED**` or `**BLOCKED**` under their final `## Verdict`. The oracle closes with
a bare `VERDICT: APPROVED` or `VERDICT: BLOCKED` line. Anything else is malformed: re-spawn that reviewer once, and
treat a second malformed reply as BLOCKED with the raw output carried into the revision loop.

All APPROVED advances to Phase 4. Any BLOCKED enters 3d.

A reviewer that returns APPROVED while mentioning plan-spec mismatches has not blocked: the verdict prevails, and
the note goes into the report. Plan-spec issues only trigger the auto-mode BLOCKER when they appear in a BLOCKED
reviewer's issue list.

**You are the filter, so read what the reviewers report and rank it.** They are told to report every defect they see
with a severity and a confidence rather than to pre-filter, because a reviewer told to be conservative reports less.
So expect MINOR and low-confidence findings, and handle them here: CRITICAL drives the verdict and 3d, IMPORTANT gets
fixed when the fix is small and recorded in the report when it is not, MINOR and anything under confidence 50 goes to
the report's notes and to the plan's `## Deferred Ideas` when it deserves a follow-up. Never enter the 3d revision
loop for a MINOR finding; that is how a safety net becomes an iteration target.

### 3d. Revision loop (cap 3 + stall detection)

If any reviewer returned BLOCKED:

1. **Read the counters off disk.** Never increment a remembered value.

   ```
   Bash: node "${CLAUDE_PLUGIN_ROOT}/cli/ac.js" review-counters .ac/plans/<slug>/review-log.md --run-prefix '## Run ' --iter-prefix '## Phase 3d Iteration' --cap 3
   ```

   Back comes `ITER=<n> PREV=<v> GATE=<OK|MAX_ITER> NEW=<count>`: the pass about to run, the previous pass's issue
   count in this run, the cap verdict, and how many fingerprints this pass introduced that the one before it did not.
   Read those verdicts; do not recompute them. Step 6 is what makes the next pass's numbers correct.

2. **Max-iter check first.** On `GATE=MAX_ITER`, `AskUserQuestion` (header `Max iter?`, options `Proceed anyway
   (Recommended)` / `Stop and surface findings` / `Investigate manually`). `Proceed anyway` advances to Phase 4 with
   the findings in the report and lets 4a tear down the marker; the other two delete the marker first, then halt.
   Auto-eligible.

3. **Stall check.** On `NEW=0` this pass surfaced nothing new: same three options under header `Stalled?`.
   A single `NEW=0` is the signal, because `NEW` first computes on the third pass and a two-consecutive rule could
   not fire before the fourth, where the cap already ended the loop. Fingerprints rather than counts, because counts
   cannot tell five new problems from the same five again: a real run logged 5, 5, 5, 5, 4 and the gate never fired.
   Auto-eligible.

4. **Apply fixes** with `Edit` at each cited `file:line`, smallest correct fix, the reviewer's `Fix:` line as
   guidance. A finding that says the PLAN is wrong rather than the code is a BLOCKER even under auto mode: name it,
   then `AskUserQuestion` (`Edit plan to fix and re-verify` / `Accept as Risk and proceed` / `Stop`). Never silently
   rewrite the plan.

5. **Re-run Phase 3a** against the fixes.

6. **Append the pass** to `.ac/plans/<slug>/review-log.md` before looping:

   ```
   ## Phase 3d Iteration <N>

   - Reviewers: <which ones ran>
   - Verdicts: <per-reviewer APPROVED / BLOCKED>
   - Issue count: <N>
   - Fingerprints: <the reviewers' per-finding Fingerprint values, comma-separated, verbatim>
   - Findings addressed: <file:line list>
   - Notes: <freeform>
   ```

   Record what the reviewers returned, not what you fixed. Every pass appends, including a malformed one
   (`Issue count: 0`, said so under Notes). A skipped append leaves the counters unchanged, and unchanging counters
   are a loop with no bound.

7. Re-read the counters, then re-spawn only when the gate allows. The append in step 6 has changed them, and 3b
   already spent pass 1, so re-spawning unconditionally here runs a fourth pass under a cap of three. On
   `GATE=MAX_ITER` take the step-2 branch instead; otherwise re-spawn with the same prompt and loop to 3c. Both
   orchestrators bound themselves the same way: the cap counts reviewer spawns, and 3b's spawn is the first one.

### 3e. Convergence

All reviewers APPROVED, or the user proceeded through an escalation gate, ends the loop. TaskUpdate Phase 3 to
`completed`, Phase 4 to `in_progress`.

## Phase 4: Deliver

Goal: commit the work, generate the dev report, render the execution summary.

### 4a. Final commit

**Delete `.ac/state/active-execution.json` first**, before the F7 check and any commit.

**F7 skip check**: run `git check-ignore -q` on every file in `MODIFIED_FILES`. If all are ignored AND
`git status --porcelain` shows tracked changes NOT in `MODIFIED_FILES`, the parent repo has unrelated work and a
commit would snapshot it as this plan's deliverable. Skip it, say so in one line, and record it in the report under
`## Commits` with the path and the count. The plan's `Git context:` field is a hint; git state is authoritative.

Otherwise invoke `/ac:commit --skip-preflight`. No `--no-push`: this is the final commit. Phase 2d and Phase 3
already covered the verification `--skip-preflight` refers to. A clean tree exits silently, which is fine.

### 4b. Report and summary

Write `.ac/plans/<slug>/report.md` from the template at `${CLAUDE_SKILL_DIR}/references/report-template.md`, filling
in the steps executed, modified files, verification outcomes, accumulated wisdom, notes, and commit hashes. Confirm
it landed with `test -f ... && wc -l ...`; retry the write once if it did not, and render the report inline if the
retry also fails, so the work is not lost in chat history.

Then render the closing summary inline from `${CLAUDE_SKILL_DIR}/references/execution-summary-template.md`. The
summary is chat output; `report.md` is the file artifact.

TaskUpdate Phase 4 to `completed`. End the turn.
