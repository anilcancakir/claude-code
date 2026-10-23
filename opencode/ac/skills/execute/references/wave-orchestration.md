<!-- ported-from: plugins/ac/skills/execute/references/wave-orchestration.md sha256:85c9e5590498451d5b1439b08e6c0a768f92c50dd0ff06d01ee70836b427cff2 -->
# Wave Orchestration: the Progress Surface and the Dependency Gate

Read at Phase 1g and again at the first wave barrier. The skill body carries the rules and the gate conditions; this file carries the procedure.

### 1g. Confirm the progress surface

There is no task list to register. opencode's `todo` tool is off unless an experimental flag turns it on, and the
two surfaces below carry everything a task list would.

The two surfaces:

- **The plan file's checkboxes** are the per-step record. Layer D ticks one per verified step, and
  `grep -c '^- \[ \]' <PLAN_PATH>` is the count. The stop guard reads the same checkboxes and lists every unticked
  one as outstanding in the continuation it sends, so the ticks are load-bearing rather than decorative.
- **The Phase 2h table** is the per-wave orientation, printed after each barrier with step, tier, result and files.

At Phase 1g:

1. Read `Steps` and `Waves` from the plan frontmatter and hold both. `Steps` is what every later Layer D count is
   compared against; a count you do not compare against anything confirms nothing.
2. Run the `plan-check` command the skill body gives at Phase 1g, copying it from there rather than retyping it, so
   the absolute path to the `ac` CLI stays the one the body names.
3. Hold the step counts it prints. On a fresh run the unchecked number equals `Steps`. On a resume it is smaller,
   and the difference is what earlier runs finished. Both numbers print on a clean exit too, so there is nothing
   to derive by hand.

A plan with zero checkboxes is repaired rather than refused, because the count is derivable from the step headings
and the plan is gaining a record it should already have rather than changing its spec. Without the repair Layer D
has nothing to tick and the stop guard sees a plan with no steps and stays silent, so both controls retire silently
and the run loses its only per-step record. Measured once on an 18-step plan: the repair took a user gate and 18
separate `edit` calls before the first worker spawned, which is what `plan-check` at the `plan` skill's Stage 5
exists to prevent from recurring.

State the step and wave totals in the Phase 2a render so the shape of the run is visible from the start.


### 2i. Wave dependency check (before launching the next wave)

After 2h's progress table, before launching the next wave's workers, check whether any failed step in the current or prior waves is a hard dependency for a step in the next wave. Sources of dependency information, in order:

1. The plan's `## Execution Strategy`, its `### Dependency Notes` section.
2. Per-step Files lists: if the next wave's step lists a file that a failed step was supposed to create, treat as a hard dependency.
3. Per-step References pointing at a failed step's output.

If a hard dependency failed:

```
question (header `Dep failed?`, options
  `Stop and investigate (Recommended)` /
  `Fix the failed step manually and resume` /
  `Skip the dependent steps and continue`
)
```

- `Stop and investigate`: delete `.ac/state/active-execution.json`, then halt; user resolves and re-runs `/ac/execute <slug>` to resume (Phase 1 writes a fresh marker on resume).
- `Fix manually and resume`: delete `.ac/state/active-execution.json`, then pause; user fixes the failed step's output, marks the step verified, and re-runs.
- `Skip the dependent steps`: mark dependent steps as `skipped` (note in report), continue to non-dependent steps in the next wave (the run continues, so the marker stays in place).

**Auto mode**: this is a BLOCKER call site (see `<auto_mode>`). Surface the question to the user EVEN IF `AUTO_MODE = true`. Before calling `question`, emit one line: `BLOCKER: Wave <M+1> has a hard dependency on a failed step in Wave <N>. Auto mode halted; user judgment required.` Continue per the user's response. AUTO_MODE stays set unless the user picks `Stop and investigate`, which terminates the run.

If no hard dependency failed, the next wave launches automatically (auto-continue policy applies).

## Phase 2a execution-strategy render

Rendered once before the wave loop starts.

```
## Execution Strategy

Plan: <title> (.ac/plans/<slug>/plan.md)
Codebase: <state>
Total steps: <N> | Waves: <N> | TDD: <tdd | tests-after | none>
Unchecked steps in the plan file: <N> (equals Total steps on a fresh run)

Wave 1 (parallel, <K> steps):
- Step 1: <title> [<tier>] <files>
- Step 2: <title> [<tier>] <files>

Wave 2 (after Wave 1):
- Step 3: <title> [<tier>] depends on Steps 1, 2

Final review: ac/plan-code-review<, + ac/oracle when a criticality surface is touched>
Checkpoint commits: <after any wave that changed tracked files | disabled>
```

## Phase 2h progress table

After each wave:

```
| # | Step | Wave | Tier | Result | Files changed |
|---|------|------|------|--------|---------------|
| 1 | <title> | 1 | junior | PASS | <file:start-end, ...> |
| 2 | <title> | 1 | quick | escalated to junior, PASS | <file:start-end> |
| 3 | <title> | 2 | senior | (in progress) | (pending) |
```
