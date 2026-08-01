# Wave Orchestration: Task Registration and the Dependency Gate

Read at Phase 1g and again at the first wave barrier. The skill body carries the rules and the gate conditions; this file carries the procedure.

### 1g. Register the pipeline as a TaskCreate task list

Call `TaskList` first. The list is session-scoped and persists on disk across `--resume` (`utils/tasks.ts:199-231`), so a long-lived session already holds the tasks of every earlier run in it. Two consequences: a resumed run of THIS slug extends its own entries instead of creating a second set, and you never delete or rewrite an entry you did not create.

Then register the pipeline. TaskCreate accepts ONE task per call (`{ subject, description, activeForm }`), so invoke it sequentially. Prefix every subject with the slug, which is what makes your own entries identifiable in a list you did not fully create:

```
// Phase 1 just finished: create, then TaskUpdate it to `completed`.
TaskCreate({ subject: "[<slug>] Phase 1: Load plan", description: "Parse plan, tier routing, init state", activeForm: "Loading plan" });

// One task per WAVE, not per step:
TaskCreate({ subject: "[<slug>] Wave 1: <n> steps", description: "<step titles, comma-separated>", activeForm: "Running wave 1" });
TaskCreate({ subject: "[<slug>] Wave 2: <n> steps", description: "<step titles, comma-separated>", activeForm: "Running wave 2" });
// ... one TaskCreate per wave ...

TaskCreate({ subject: "[<slug>] Phase 3: Final code-review", description: "Spawn ac:plan-code-review (+ oracle parallel for complex)", activeForm: "Spawning code-review" });
TaskCreate({ subject: "[<slug>] Phase 4: Deliver", description: "/ac:commit + report.md + summary", activeForm: "Delivering" });

// Then TaskUpdate the Wave 1 task to `in_progress` (Phase 2 starts after this call).
```

Wave granularity is deliberate. Per-step entries put the same information in three places (the task list, the plan file's checkboxes, and the Phase 2h progress table) and turn a ten-step plan into twelve list entries, which is how a multi-day session accumulates dozens of stale-looking rows. The plan file is the per-step record; this list is orientation.

Update each task to `in_progress` on entry and `completed` on verified exit, and never leave one `in_progress` past its wave. At Phase 4 every `[<slug>]` task is `completed`; if a wave ended with failed steps, the wave task still completes and the failures are reported in `report.md`, because a task left open forever is worse signal than a closed one with a caveat.


### 2i. Wave dependency check (before launching the next wave)

After 2h's progress table, before launching the next wave's workers, check whether any failed step in the current or prior waves is a hard dependency for a step in the next wave. Sources of dependency information, in order:

1. The plan's `## Execution Strategy` → `### Dependency Notes` section.
2. Per-step Files lists: if the next wave's step lists a file that a failed step was supposed to create, treat as a hard dependency.
3. Per-step References pointing at a failed step's output.

If a hard dependency failed:

```
AskUserQuestion (header `Dep failed?`, options
  `Stop and investigate (Recommended)` /
  `Fix the failed step manually and resume` /
  `Skip the dependent steps and continue`
)
```

- `Stop and investigate`: delete `.ac/state/active-execution.json`, then halt; user resolves and re-runs `/ac:execute <slug>` to resume (Phase 1 writes a fresh marker on resume).
- `Fix manually and resume`: delete `.ac/state/active-execution.json`, then pause; user fixes the failed step's output, marks the step verified, and re-runs.
- `Skip the dependent steps`: mark dependent steps as `skipped` (note in report), continue to non-dependent steps in the next wave (the run continues, so the marker stays in place).

**Auto mode**: this is a BLOCKER call site (see `<auto_mode>`). Surface the question to the user EVEN IF `AUTO_MODE = true`. Before calling `AskUserQuestion`, emit one line: `BLOCKER: Wave <M+1> has a hard dependency on a failed step in Wave <N>. Auto mode halted; user judgment required.` Continue per the user's response. AUTO_MODE stays set unless the user picks `Stop and investigate`, which terminates the run.

If no hard dependency failed, the next wave launches automatically (auto-continue policy applies).

## Phase 2a execution-strategy render

Rendered once before the wave loop starts.

```
## Execution Strategy

Plan: <title> (.ac/plans/<slug>/plan.md)
Complexity: <complexity> | Codebase: <state>
Total steps: <N> | Waves: <N> | TDD: <tdd | tests-after | none>

Wave 1 (parallel, <K> steps):
- Step 1: <title> [<tier>] <files>
- Step 2: <title> [<tier>] <files>

Wave 2 (after Wave 1):
- Step 3: <title> [<tier>] depends on Steps 1, 2

Final review: <ac:plan-code-review | ac:plan-code-deep-review + ac:oracle>
Checkpoint commits: <enabled (wave-after) | disabled>
```

## Phase 2h progress table

After each wave:

```
| # | Step | Wave | Tier | Result | Files changed |
|---|------|------|------|--------|---------------|
| 1 | <title> | 1 | junior | PASS | <file:line, ...> |
| 2 | <title> | 1 | quick | escalated → junior PASS | <file:line> |
| 3 | <title> | 2 | senior | (in progress) | (pending) |
```
