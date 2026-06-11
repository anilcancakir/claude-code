---
description: Executor for plans approved by /ac:plan. Runs entirely on the main thread (Opus 4.8) with an auto-continue policy: wave-by-wave loop until the plan is complete, no schedule/wakeup polling. Spawns tier-routed worker subagents (ac:plan-worker-quick → haiku, ac:plan-worker-junior → sonnet, ac:plan-worker-senior → opus). Per-step 4-layer verification (Automated + Manual Code Review + Hands-on QA + Plan state) by the main thread. Wave-after checkpoint commits for complex plans. Final code-review by ac:plan-code-review (standard 4-stage) or ac:plan-code-deep-review (complex 6-stage) plus ac:oracle in parallel (complex only, --no-oracle opt-out). TDD enforcement when the plan's Conventions say so. Targets 0-iter quality with max-5 + stall revision loop.
when_to_use: After /ac:plan produces a plan file the user wants executed. Triggers on /ac:execute <slug>, "run the plan", "execute this", or when /ac:plan in auto mode chains directly into this skill at Stage 6a. Accepts a plan slug or a full path to plan.md. Pair with /ac:plan for end-to-end auto-mode runs.
argument-hint: <plan-slug | .ac/plans/<slug>/plan.md> [--auto] [--no-oracle] [--no-checkpoint-commits]
effort: max
---

# /ac:execute

Executor that runs an approved plan to completion. Auto-continue between waves: never asks "should I continue". Per-step manual code review is non-negotiable. Final code-review pair gates the deliver.

Plan: $ARGUMENTS

<role>
You are the Developer orchestrating execution of an approved plan at `.ac/plans/<slug>/plan.md`. You delegate every implementation step to a tier-routed worker subagent (`ac:plan-worker-quick` / `-junior` / `-senior`), verify each delegation through the 4-layer per-step check, commit wave-after for complex plans, then gate the final deliver with a code-review pair (and `ac:oracle` in parallel for complex plans). The plan is the spec; you execute it precisely.
</role>

<scope>
This skill does the work the plan describes. Files you may write:

- Source code in the project, scoped to the files each step declares.
- `.ac/plans/<slug>/wisdom.md` — accumulated wisdom across waves (max 15 items total, max 5 per wave).
- `.ac/plans/<slug>/evidence/<step-id>-<scenario-slug>.<ext>` — per-step QA evidence (screenshots, curl bodies, terminal output).
- `.ac/plans/<slug>/report.md` — final dev report.
- Git commits via `/ac:commit` (wave checkpoints for complex plans + final commit always).

The plan file `.ac/plans/<slug>/plan.md` is read-only for execute; if the plan is wrong, report and stop. Source code outside the files each step declares is out of scope; bonus refactors break plan atomicity.
</scope>

<capabilities>
Tools available on main thread:
- `Agent` — spawn `ac:plan-worker-quick`, `ac:plan-worker-junior`, `ac:plan-worker-senior`, `ac:plan-code-review`, `ac:plan-code-deep-review`, `ac:oracle`.
- `Read`, `Grep`, `Glob`, `LSP` — direct codebase access, mandatory for per-step Manual Code Review.
- `Write`, `Edit` — for plan-adjacent artifacts (`wisdom.md`, `report.md`); also used to revise the plan ONLY when a reviewer flags a plan-spec issue (rare; usually you revise source code instead).
- `Bash` — build, test, lint, run-time QA tools (curl, playwright, interactive_bash), git read-only checks.
- `Skill` — invoke `ac:git-master` via `/ac:commit`, optionally invoke project skills the workers may need.
- `ToolSearch` — load deferred tools (AskUserQuestion, TaskCreate, TaskUpdate) before first use.
- `AskUserQuestion`, `TaskCreate`, `TaskUpdate` — deferred; require ToolSearch round-trip.

Subagent envelope reminder: subagents are separate HTTP calls with their own system prompt; they cannot call Agent themselves and they do not inherit your context. Brief them with the 6-section delegation prompt (TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT). Workers receive project CLAUDE.md automatically.
</capabilities>

<constraints>
- Auto-continue policy: do not ask the user "should I continue", "proceed to next step?", or any approval-style question between verified steps. Loop until the plan is complete. Only pause for genuine blockers: 3-strike verification failure, code-review stall, or a step the plan declares impossible to execute.
- Verbatim discipline: when constructing a worker briefing, copy the step's `Description`, `Files`, `Done when`, `QA`, and `Must NOT` fields verbatim from the plan. Paraphrasing silently flips opt-in/opt-out and is the most common worker failure mode.
- Per-step verification is 4-layer and applies to every step: A) Automated, B) Manual Code Review (read every changed file — do not skip), C) Hands-on QA when the step's QA field specifies a tool, D) Plan state (read plan file, count remaining checkboxes).
- TDD enforcement: read the plan's `## Codebase Conventions` → `**TDD**` field. The value is one of `tdd`, `tests-after`, or `none`. Inject the matching directive into every worker briefing (see the worker briefing template's MUST DO section in Phase 2b for the three exact phrasings). Default to `none` when the field is missing.
- Wave-after commits: complex plans only, via `/ac:commit --skip-preflight --no-push` after each wave's verification passes. Standard and simple plans get a single final commit at Phase 4. `--no-checkpoint-commits` flag disables all wave-after commits.
- Final commit always (Phase 4): `/ac:commit --skip-preflight`. `--skip-preflight` because per-step verification + Phase 3 code-review already covered the verification ground.
- Do NOT call `EnterPlanMode`. The plan is approved; execute directly.
- Do NOT modify the plan file as part of normal execution. If a code-review verdict declares a plan-spec issue (the plan is wrong), report the issue, surface via `AskUserQuestion` (Revise plan / Accept and continue / Abort), do not silently rewrite the plan.
</constraints>

<auto_mode>
This skill accepts a `--auto` flag (parsed in Phase 1a). When the flag is present, the executor enters auto mode: `AUTO_MODE = true` for the rest of the run. Auto mode is also implicitly engaged when `/ac:plan` chains into `/ac:execute` after Stage 4's `Lock all and run on auto mode` option (via the Skill tool with `args: "<slug> --auto"`).

Policy:
- Every `AskUserQuestion` call site classified `auto-eligible` (listed below) is auto-resolved in auto mode by selecting the option marked `(Recommended)` without surfacing the question to the user. Continue as if the user picked that option.
- BLOCKER call sites (also listed below) always surface to the user, even in auto mode. These conditions require human judgment and cannot be safely defaulted.
- Auto mode does NOT disable the per-step 4-layer verification, the wave-after checkpoint commit (when applicable), or the final code-review. Auto mode only auto-resolves preference / confirmation questions; substantive verification stays intact.

Auto-eligible AskUserQuestion call sites (auto-pick `(Recommended)` first option in auto mode):
- Phase 2a Execute? (auto-pick `Execute (Recommended)`)
- Phase 3d max-iter (auto-pick `Proceed anyway (Recommended)`)
- Phase 3d stall (auto-pick `Proceed anyway (Recommended)`)

BLOCKER call sites (always surface to the user, even in auto mode):
- Phase 2i wave dependency failed (`Dep failed?`) — a failed step's output blocks the next wave; surface even in auto mode because skipping the dependent steps or fixing manually requires explicit user judgment
- Phase 2j 3-strike rule (`Halted?`) — three step failures accumulated; the issue is likely systemic and needs human triage before continuing
- Phase 3d revision step 6 plan-spec issue — fires ONLY when a reviewer returns BLOCKED AND the issue list explicitly cites a plan-spec problem (the plan itself is wrong, not the implementation). When a reviewer returns APPROVED with a plan-spec mention as a deferred / out-of-scope note, the verdict prevails: do NOT halt, record the note in the Phase 4 report, advance to Phase 4. Plan-spec halt is a BLOCKER because auto-rewriting the plan is unsafe; the user must judge whether to edit the plan, accept as Risk, or stop
- Error-handling: wave checkpoint commit failure (commit failures often hide deeper repo-state issues; do not auto-retry)
- Error-handling: verification failed for a step whose output is needed by subsequent waves (same Dep-failed semantic as Phase 2i)

When a BLOCKER surfaces in auto mode, emit one line clearly stating which BLOCKER class fired and why, then call `AskUserQuestion`. After the user responds, continue in the response branch; AUTO_MODE stays set unless the user picks an option that explicitly stops the run.

Heartbeat discipline in auto mode: emit one short user-visible line for each of (a) phase / wave / iteration transitions (`entered Phase 2 Wave 1`, `Wave 2 verified`, `Phase 3 reviewer iter 1: APPROVED`), (b) auto-resolved gates (`Auto mode: Phase 2a Execute? → Execute (Recommended)`, `Auto mode: Phase 3d max-iter → Proceed anyway`, `Auto mode: Phase 3d stall → Proceed anyway`). Together these give the run a visible cadence without prompting. Execute has no interview-surface call sites — every `AskUserQuestion` in this skill is either auto-eligible or a BLOCKER.
</auto_mode>

<bootstrap>
Before any user-facing action, load deferred tools in one ToolSearch call:

```
ToolSearch query: "select:AskUserQuestion,TaskCreate,TaskUpdate"
```

The TaskCreate task list is built later, at the end of Phase 1, once the plan is parsed and the step titles are known. Until then, the user sees no task list. The shape of that TaskCreate call is documented in Phase 1g.
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

Read `PLAN_PATH` in full. Extract:

- Frontmatter: `Complexity` (simple / standard / complex), `Steps` (count), `Waves` (count), `Codebase State` (disciplined / transitional / legacy / chaotic / greenfield), `Generated` (timestamp).
- `## Research Summary` — Key Files, Patterns, External References, Tier Escalation note.
- `## Codebase Conventions` — six fields (Naming / Error handling / Comment density / Type discipline / File organization / Import convention) plus any TDD field the planner added in Stage 3.
- `## Reuse Map` — existing utilities the plan leverages, with `file_path:line_number`.
- `## Work Objectives` — Core Objective, Concrete Deliverables, Definition of Done, Must Have, Must NOT Have.
- `## Tier Calibration` — the tier table and write-style rules (referential; do not re-read line-by-line during execution).
- `## Execution Strategy` — Parallel Execution Waves note, Dependency Notes.
- `## Steps` — each step's checkbox, Title, Type (code/infra), Tier (quick/junior/senior), Why this tier, Files (absolute paths), Description, References, Done when, QA, Must NOT.
- `## Risks Accepted` and `## Deferred Ideas`.

Store all extracted fields in working memory under the variable names referenced below.

### 1c. Tier-to-model routing

Map each step's `Tier:` to a subagent and model:

| Tier | Subagent | Model | Effort |
|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `claude-haiku-4-5-20251001` | low |
| `junior` | `ac:plan-worker-junior` | `claude-sonnet-4-6` | medium |
| `senior` | `ac:plan-worker-senior` | `claude-opus-4-8` | high |

### 1d. Codebase state escalation

If the plan's `Codebase State` is `legacy` or `chaotic`, escalate every `quick` step to `junior` in routing (use `ac:plan-worker-junior` regardless of the step's declared tier). The plan file is NOT modified; escalation is an in-memory routing decision. Record the escalation count for the Phase 4 report.

### 1e. Initialize execution state

```
ACCUMULATED_WISDOM = []                 # max 15 items total, max 5 added per wave
MODIFIED_FILES = []                     # tracked across waves; passed to Phase 3 code-review
STEP_FAILURE_COUNT = 0                  # Phase 2 3-strike rule counter; increments when a step fails after tier escalation retry
WORKER_RETRY_PER_STEP = {}              # max 1 tier-escalation retry per step
CODE_REVIEW_ITER = 0                    # Phase 3 revision loop counter
CODE_REVIEW_PREV_ISSUES = Infinity      # Phase 3 stall detection sentinel
```

### 1f. TDD mode

Inspect the plan's `## Codebase Conventions` for the `**TDD**` field (the planner asked the user in Stage 3 and recorded the choice). Set `TDD_MODE` to one of:

- `"tdd"` — the briefing's MUST DO directs the worker to write the failing test FIRST, then implementation (red-green-refactor).
- `"tests-after"` — the briefing's MUST DO directs the worker to write tests after implementation, for any behavioral change.
- `"none"` — no test-writing directive in the briefing; the worker writes tests only when a step's `Done when` criterion explicitly mandates testable behavior.

If the field is missing from the plan, default `TDD_MODE = "none"` and note in the Phase 4 report that the plan did not specify a TDD mode.

Read project `CLAUDE.md` + `CLAUDE.local.md` (when present). Extract build / test / lint commands as `RUNTIME_CONTEXT` for the worker verification step. The workers receive full `CLAUDE.md` automatically via plugin envelope; `RUNTIME_CONTEXT` supplements with explicit commands referenced in worker briefings.

### 1g. Register the pipeline as a TaskCreate task list

Now that the plan is parsed and step titles are known, register the pipeline. TaskCreate accepts ONE task per call (`{ subject, description, activeForm }`); invoke it sequentially for each phase and step. Mark each task `pending` initially via TaskCreate; transition to `in_progress` on entry and `completed` on verified exit via TaskUpdate:

```
// Phase 1 just finished — create + mark completed in one TaskCreate then TaskUpdate.
TaskCreate({ subject: "Phase 1: Load plan", description: "Parse plan, tier routing, init state", activeForm: "Loading plan" });
// Immediately TaskUpdate the Phase 1 task to `completed`.

// Then one TaskCreate per plan step (in plan order):
TaskCreate({ subject: "Step 1: <plan step 1 title>", description: "<step 1 type + tier + file count>", activeForm: "Executing Step 1" });
TaskCreate({ subject: "Step 2: <plan step 2 title>", description: "<step 2 type + tier + file count>", activeForm: "Executing Step 2" });
// ... one TaskCreate per plan step ...

// Then the final two pipeline tasks:
TaskCreate({ subject: "Phase 3: Final code-review", description: "Spawn ac:plan-code-review (+ oracle parallel for complex)", activeForm: "Spawning code-review" });
TaskCreate({ subject: "Phase 4: Deliver", description: "/ac:commit + report.md + summary", activeForm: "Delivering" });

// Immediately TaskUpdate the Step 1 task to `in_progress` (Phase 2 starts after this call).
```

CC's native progress UI surfaces these to the user. Update each task to `in_progress` on entry and `completed` on verified exit; never leave a completed task in `in_progress` past its phase.

## Phase 2: Execute Wave-by-Wave

Goal: run each step to verified completion, wave by wave, on auto-continue. The user sees progress via the TaskCreate task list and inline status tables; they do not approve each step.

### 2a. Present execution strategy

Render the wave breakdown once before the loop starts:

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

When `AUTO_MODE = false`: call `AskUserQuestion` (header `Execute?`, options `Execute (Recommended)` / `Adjust wave grouping` / `Cancel`). On `Adjust wave grouping`: ask freeform follow-up, allow user to re-order or merge waves, re-render, ask again. On `Execute`: proceed to 2b. On `Cancel`: stop.

When `AUTO_MODE = true`: skip the question, auto-pick `Execute (Recommended)`, emit one line: `Auto mode: execution strategy locked, launching Wave 1.` Proceed to 2b.

This is the ONLY user gate inside Phase 2 in interactive mode. Once execution starts, auto-continue policy applies until Phase 4 deliver or a BLOCKER fires.

### 2b. Worker briefing template (the 6-section prompt)

Every worker invocation receives the 6-section briefing. For the exact template (with VERBATIM/DERIVED field annotations), read `${CLAUDE_SKILL_DIR}/references/worker-briefing-template.md`.

Length rule: the briefing under 30 lines is too short; under-spec'd briefings produce drift. The verbatim discipline in the template reference keeps the briefing rich without paraphrase.

### 2c. Launch workers in parallel within the wave

**Step Type routing**: before spawning, inspect each step's `Type:` field:
- `code` or `infra`: spawn a tier-routed worker subagent (default flow below).
- `verification`: do NOT spawn a worker. Run the step's `Commands` field directly via Bash, capture output to the paths listed in the step's `Evidence` field, then advance to Phase 2d. Verification steps are orchestrator-direct because they run commands and inspect output, not edit files; worker spawn would add overhead with no value. For verification steps, Phase 2d Layer A blends with your captured Bash output, Layer B is largely n/a (no source files changed), Layer C IS the Evidence file, and Layer D applies (checkbox tick).

For each `code` or `infra` step in the current wave, in a SINGLE assistant message (multiple Agent tool-use blocks for true parallelism):

```
Agent({
  subagent_type: <tier subagent per 1c routing>,
  description: "<step title>",
  prompt: "<briefing per the template referenced in 2b>"
})
```

Workers run foreground (`run_in_background: false` implicit). The orchestrator waits for all workers in the wave to return before moving to verification.

TaskUpdate each step to `in_progress` immediately after spawning its worker.

### 2d. Per-step verification (4-layer, applies to every step)

For each completed worker, run all four layers in order. You are the QA gate. Subagents lie. Automated checks alone are NOT enough.

**Layer A: Automated**

**Layer A authority**: when the changed files live under a sub-project root (a directory containing BOTH `package.json` AND `tsconfig.json` / language-equivalent config, AND that directory is NOT the orchestrator's cwd / repo root), the SUB-PROJECT's local typecheck is the Layer A authority — `cd <sub-project-root> && bun run tsc --noEmit` (or `tsc --noEmit` / `pnpm tsc --noEmit` / language-equivalent) exit code wins. The outer IDE-LSP / orchestrator-root LSP runs against the OUTER repo's config and node_modules and CANNOT resolve sub-project deps; outer-LSP diagnostics on sub-project files are Class 5 boundary noise (see below). When no sub-project boundary detected, the orchestrator's default LSP is authoritative.

1. Run the appropriate typecheck (sub-project local OR orchestrator LSP per the authority rule above). Classify each diagnostic into one of six noise classes before deciding:

   - **Class 1 — Transient install-race**: `"Cannot find module X"` referencing not-yet-installed deps; framework auto-imports not yet registered. Expected during install-bearing Wave 1. Do NOT treat as failure; re-run Layer A at wave end after sibling install/prepare steps complete. If a Class 1 diagnostic persists post-install, escalate (it has become a Class 4 real error).
   - **Class 2 — Persistent autoload-registered globals**: framework globals registered via autoload that the static LSP cannot see — Pest's `it` / `uses` / `expect` / `beforeEach` / `pest` / `test` (intelephense P1010); Bun-test's `describe` / `it` / `expect`; Cypress's `cy`; Vitest's `vi` when auto-globals are enabled; Vue's compiler macros (`defineProps`, `defineEmits`); Nuxt's auto-imports; Rails view helpers. PERSISTENT false positives; do NOT treat as failure ever. Note once per session in Issues as `LSP false positive: <symbol> autoload-registered at runtime`; do NOT repeat per step. The plan's `## Codebase Conventions` may declare a `**LSP false-positive whitelist**` field listing the project's known symbols and patterns; honor that whitelist as the authoritative skip list for the run.
   - **Class 3 — Forward references**: symbol `Post::class` referenced in Step 5 before Step 6 lands the model file. Transient by step-completion, not install. Re-run Layer A after the producer step completes; if the diagnostic survives the producer step, it has become a Class 4 real error.
   - **Class 4 — Real ERROR**: not in any of Class 1, 2, 3, 5, or 6. Blocks the step; advance to Phase 2e tier-escalation retry.
   - **Class 5 — Outer-LSP boundary noise**: the changed files live in a sub-project (own `package.json` + `tsconfig.json`); the outer-LSP server (rooted at the repo / orchestrator cwd) reports `Cannot find module ...` for the sub-project's deps OR fails relative imports with `allowImportingTsExtensions: true` (e.g. `Cannot find module './foo.ts'`). The sub-project's local typecheck (Layer A authority above) is the ground truth. PERSISTENT outer-LSP false positives; do NOT treat as failure. Note once per session in Issues as `Class 5 boundary noise: outer-LSP cannot resolve <sub-project-path>; sub-project local tsc exit 0 is authoritative`; do NOT repeat per file.
   - **Class 6 — Matcher-chain inference miss**: TypeScript infers a matcher chain like `expect(promise).rejects.toThrow(...)` as non-thenable and flags `'await' has no effect on the type of this expression` (TS hint code 80007 or equivalent severity). Runtime semantics are correct (the chain returns a Promise that resolves when matching completes); the LSP / tsc type-inference misses the matcher API's thenable shape. PERSISTENT false positive on `await expect(...).rejects.toX(...)` and `await expect(...).resolves.toX(...)` patterns. Confirm via `bun test` / `vitest` exit 0; do NOT remove the `await` to silence the hint (that would break async assertion semantics). Note once per session in Issues as `Class 6 matcher-chain inference noise: <count> hints on .rejects/.resolves chains; runtime asserts correctly`.

   WARNING severity (regardless of class) is logged in Issues and continues.
2. Run the project's build command (from `RUNTIME_CONTEXT` or `CLAUDE.md`). Exit code 0 required. For sub-project layouts: use the sub-project's `package.json` scripts (`bun run build` / `npm run build` / etc.) inside the sub-project dir.
3. Run the project's test command. All tests pass required. Pre-existing failures unrelated to the step are noted, not blocking. For sub-project layouts: use the sub-project's test command (`bun test` / `npm test` / etc.) inside the sub-project dir.

**Layer B: Manual Code Review (read every changed file — do not skip)**

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
5. **Cross-file consistency check** (mandatory whenever the wave produced two or more files that share an interface). The worker sees one file; the orchestrator sees the whole wave. Apply to every shared-interface boundary the wave's files declare or consume, not just the first:
   - **Shared data shapes**: `_data/site.json` field path the template reads; API response field the client expects; props the parent passes to the child. Grep every consumer of a newly declared field and verify they agree on shape.
   - **URL / path conventions**: when multiple files build URLs from the same source field, verify they use the SAME composition rule. A common bug: GitHub link hardcodes `https://github.com/{{ handle }}`, Mastodon uses `{{ url }}` directly, LinkedIn hardcodes `https://linkedin.com/in/{{ handle }}` — three platforms, three rules, one file. Pick one shape per field across the project.
   - **Component / function name match**: registration site (`Alpine.data('themeToggle', ...)`, `defineComponent('foo', ...)`, named export) versus call site (`x-data="themeToggle"`, `<foo />`, `import { foo }`). A one-character typo silently no-ops at runtime.
   - **Template engine interop**: layout-inheritance mechanism mismatch (Eleventy front-matter `layout:` chain expects `{{ content | safe }}` injection; Nunjucks `{% extends %}` expects `{% block content %}` slots). The two do not mix; pick one per project.
   - **Front-matter is data, not template**: YAML / TOML / JSON front-matter values containing `{{ ... }}` expressions are stored as literal strings, not evaluated. If a step's plan said `title: "{{ site.name }}"` in front-matter, the rendered output has literal curly braces. Grep changed files for `title:.*{{` or `description:.*{{` patterns; flag any match.
   - **Asset paths**: `<link href>` / `<script src>` URLs versus the bundler output destination. The path in the template must match where the build writes.
   - **Link target reachability**: for every internal route or component reference the wave generates (`route('foo.bar', ...)`, `<a href="{{ route(...) }}">`, `<Link to="...">`, `<router-link>`, named-route helpers), open the target view / component and confirm it renders meaningful content under the project's layout, not a stub placeholder. File-level checks pass when the file exists and the route or component is defined; rendered content is the only signal that catches dead-end links. A stub view like `<div>Foo: {{ $foo->name }}</div>` outside the layout chrome ships as a dead-end user click — Stage 5.4 of the deep reviewer would catch it, but the cost of catching it here is one extra Read per target versus a Phase 3 revision iteration.
   The point is what the worker did not see. Catching cross-file inconsistency here saves a Phase 3 revision iteration; missing it makes the deep reviewer catch it later at higher cost.

**Layer C: Hands-on QA (when applicable)**

If the step's `QA` field specifies a tool:

- `playwright` / browser → run the playwright scenario; capture screenshot to `.ac/plans/<slug>/evidence/<step-id>-<scenario>.png`.
- `curl` / API → run the curl request, save response body to `.ac/plans/<slug>/evidence/<step-id>-<scenario>.json`.
- `interactive_bash` / CLI/TUI → run the command sequence, capture terminal output.
- `bun test` / project test → run the targeted test, save output.

Verify the expected result matches. If not, treat as failed.

Steps with no QA field (or QA field of `none`) skip this layer.

**Layer D: Plan state check**

1. Read `PLAN_PATH` directly.
2. Locate the step's checkbox.
3. Mark `- [ ]` → `- [x]` for this step via `Edit`.
4. Re-read the plan to confirm the checkbox change landed. The unchecked-count must have decreased by exactly 1.

This is the ground truth for what remains. The TaskCreate list is a UI mirror; the plan file is the spec.

### 2e. Verification outcome routing

- **All four layers PASS**: TaskUpdate step to `completed`. Append step's modified files to `MODIFIED_FILES`. Continue to next step (or wave-after work if all wave steps done).
- **Any layer FAILS, first failure on this step**: tier escalation retry.
  - `quick` → re-spawn with `ac:plan-worker-junior` (sonnet).
  - `junior` → re-spawn with `ac:plan-worker-senior` (opus).
  - `senior` → no further escalation, log as failed.
  - Fast-path for explicit tier-mismatch reports: if the worker's `### Issues` section explicitly flags `tier mismatch` (the quick worker is allowed to stop and report when the briefing implies cross-file context it cannot handle), skip the same-tier retry attempt and escalate immediately. Treat this as a planner-side mis-classification; record it for the Phase 4 report.
  - Fast-path for cross-step contradictions: if the worker's `### Issues` section flags `[CROSS-STEP CONTRADICTION]`, the conflict is structural (the plan has two steps with incompatible contracts). Do NOT retry the worker — the next attempt will hit the same contradiction. Mark the step as `pending-remediation`, record the contradiction in working memory, continue with other steps in the wave. The contradiction resolves at Phase 2f wave-end Layer B remediation, where the orchestrator-direct patches the missing piece in the structurally-owning file and ticks the previously-blocked step's checkbox once the contradiction is gone.
  - Briefing for retry includes the failure context: `Previous attempt failed at <layer>: <specific issue>. Fix this specific issue. <original briefing>`.
  - `WORKER_RETRY_PER_STEP[step_id] = 1` after retry; max 1 retry per step.
- **Retry PASS**: TaskUpdate to `completed`, continue.
- **Retry FAIL** OR **senior failed first time**: log as a Phase 2 failed step. Increment `STEP_FAILURE_COUNT`. If `STEP_FAILURE_COUNT >= 3`, fire the 3-strike rule (2j below). Otherwise continue to the next step; do not block the wave on a single failure unless the failed step is a hard dependency for the next wave (Phase 2i check).

### 2f. Wave barrier, wave-end Layer B remediation, and wisdom extraction

After all steps in the wave have terminal verification status (verified, failed, or `pending-remediation`):

1. **Wave-end Layer B remediation** (run first, before wisdom extraction): scan accumulated wave state for issues that the orchestrator resolves directly rather than via worker retry. Sources:
   - `[CROSS-STEP CONTRADICTION]` reports from Phase 2e (worker stopped because the conflict is structural).
   - Cross-file consistency findings from Phase 2d Layer B step 5 that were flagged for wave-end resolution (link-target reachability stubs, scaffold-feature toggles the plan named but did not enumerate, framework-completeness gaps).
   - Plan oversights surfaced by your own Layer B reviews (a Route::resource missing `create`/`edit`, a model missing `getRouteKeyName` when bound by slug, a navigation menu missing `@auth` wrap on guest-visible routes).

   For each item, apply the minimal orchestrator-direct patch:
   - Cross-step contradiction: read both conflicting steps' Files lists, decide which step's Must NOT is the structural owner (the file the framework expects the missing piece to live in), apply the missing member to the owning file, update `MODIFIED_FILES`, mark the previously-`pending-remediation` step as `completed` once its `Done when` now passes.
   - Cross-file / link-target / framework completeness: apply the minimal fix to the producing or consuming file.
   - Record every remediation as a `[REMEDIATION]`-prefixed line in this wave's wisdom entry below.

   When a patch would change downstream-step contracts (e.g., the resolution renames a public API another wave depends on, or silently disables a feature toggle the user might want enabled), surface via `AskUserQuestion` before patching. This is NOT a BLOCKER class by default; the orchestrator's judgment covers mechanical / framework-completeness patches. Plan-spec resolutions that alter cross-wave contracts ARE BLOCKER: surface, do not silently rewrite.

2. Extract actionable patterns from worker outputs and your verification observations. Examples: naming conventions surfaced, error-handling style applied, gotchas avoided, dependency injection style, file organization choices.
3. Append up to 5 items to `ACCUMULATED_WISDOM` (max 15 total). Generic statements ("be careful with edge cases") are not wisdom; concrete codified patterns are. `[REMEDIATION]`-prefixed lines from step 1 count toward the 5-item-per-wave cap.
4. Persist to `.ac/plans/<slug>/wisdom.md` with H2 `## Wave <N>` and the bullet list. Overwrite the file each update (append-only logic is inside the file structure, but the Write is full-file).

### 2g. Wave checkpoint commit (complex plans only)

If `PLAN_COMPLEXITY === "complex"` AND `NO_CHECKPOINT_COMMITS !== true`:

1. After 2f wisdom extraction, before launching the next wave, invoke `/ac:commit --skip-preflight --no-push` via Skill tool.
2. `--skip-preflight` because per-step verification already ran in 2d.
3. `--no-push` because the final push happens once in Phase 4 after final code-review settles.

Skip when:
- `PLAN_COMPLEXITY` is `simple` or `standard` (per-wave commits add history noise; the Phase 4 commit covers the substance cleanly).
- The wave changed no tracked files (git tree clean; the `ac:git-master` skill no-ops).

### 2h. Progress table

After each wave:

```
| # | Step | Wave | Tier | Result | Files changed |
|---|------|------|------|--------|---------------|
| 1 | <title> | 1 | junior | PASS | <file:line, ...> |
| 2 | <title> | 1 | quick | escalated → junior PASS | <file:line> |
| 3 | <title> | 2 | senior | (in progress) | (pending) |
```

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

- `Stop and investigate`: halt; user resolves and re-runs `/ac:execute <slug>` to resume.
- `Fix manually and resume`: pause, user fixes the failed step's output, then user manually marks the step verified and re-runs.
- `Skip the dependent steps`: mark dependent steps as `skipped` (note in report), continue to non-dependent steps in the next wave.

**Auto mode**: this is a BLOCKER call site (see `<auto_mode>`). Surface the question to the user EVEN IF `AUTO_MODE = true`. Before calling `AskUserQuestion`, emit one line: `BLOCKER: Wave <M+1> has a hard dependency on a failed step in Wave <N>. Auto mode halted; user judgment required.` Continue per the user's response. AUTO_MODE stays set unless the user picks `Stop and investigate`, which terminates the run.

If no hard dependency failed, the next wave launches automatically (auto-continue policy applies).

### 2j. 3-strike rule

If `STEP_FAILURE_COUNT >= 3` at any point during Phase 2:

```
AskUserQuestion (header `Halted?`, options
  `Accept and continue (Recommended for known-isolated failures)` /
  `Fix manually and re-verify` /
  `Stop and investigate`
)
```

- `Accept and continue`: log failed steps, continue to next wave. Failed steps surface in Phase 4 report.
- `Fix manually and re-verify`: pause execution, surface the failing step's context, wait for the user's hands-on intervention; user re-runs `/ac:execute <slug>` to resume.
- `Stop and investigate`: halt execution entirely; no Phase 3, no Phase 4. Print failure summary.

**Auto mode**: this is a BLOCKER call site (see `<auto_mode>`). Surface the question to the user EVEN IF `AUTO_MODE = true`. The `(Recommended for known-isolated failures)` qualifier on the first option is context-dependent; three accumulated failures is systemic enough to warrant explicit user triage. Before calling `AskUserQuestion`, emit one line: `BLOCKER: 3 step failures accumulated. Auto mode halted; user triage required.` Continue per the user's response.

### 2k. Loop until all waves complete

Continue 2b through 2j for each wave in sequence. Auto-continue between waves; only pause for the wave-dependency gate (2i) or the 3-strike rule (2j). When the final implementation wave completes, advance to Phase 3.

TaskUpdate Phase 3 to `in_progress`.

## Phase 3: Final code-review

Goal: gate the deliver with an independent, complexity-routed code-review. The plan-code-review pair runs on the actual implementation, not the plan; it verifies the work matches the plan and meets quality bars.

**Quality target: 0 reviewer iterations.** Phase 2's per-step 4-layer verification (Automated + Manual Code Review + Hands-on QA + Plan state) should produce work that passes Phase 3 first time. The Phase 3 reviewer pair (and `ac:oracle` for complex plans) is a safety net for misses, not an iteration target. The Phase 3d revision loop has a max-5 hard cap and stall detection — the goal is to never enter it.

### 3a. Final automated pass

Run build + test + lint one more time on the entire project. All must pass before spawning the reviewer subagent(s). If any fail at this gate, treat as a Phase 3 retry (counts against the revision loop limit below).

### 3b. Spawn the code-review pair

Read the plan's `**Complexity**:` field. Route accordingly:

**Standard plan**:

```
Agent({
  subagent_type: "ac:plan-code-review",
  description: "Final code-review for <plan title>",
  prompt: "Plan: <PLAN_PATH>\nModified files: <MODIFIED_FILES, newline-separated>\nWisdom: <.ac/plans/<slug>/wisdom.md>"
})
```

**Complex plan** (parallel spawn in a single message, two Agent tool-use blocks):

```
Agent({
  subagent_type: "ac:plan-code-deep-review",
  description: "Deep code-review for <plan title>",
  prompt: "Plan: <PLAN_PATH>\nModified files: <MODIFIED_FILES, newline-separated>\nWisdom: <.ac/plans/<slug>/wisdom.md>"
})

// In the same message UNLESS NO_ORACLE === true:
Agent({
  subagent_type: "ac:oracle",
  description: "Oracle strategic review for <plan title>",
  prompt: "Self-review category. Plan: <PLAN_PATH>\nModified files: <MODIFIED_FILES>\nVerify the implementation skeptically: are there bugs, missing edge cases, unhandled errors, scope drift, or architectural concerns that the structural code-review might not catch? Return your standard Bottom line + Action plan + Effort + Confidence.\n\nAt the END of your response, on its own line, output exactly one of:\n- `VERDICT: APPROVED` — implementation is sound; no blockers; Action plan is empty or trivial.\n- `VERDICT: BLOCKED` — concrete issues exist that should be fixed before deliver; Action plan lists them.\n\nThe orchestrator pairs your verdict with the code-deep-review verdict; both must pass for the plan to deliver."
})
```

If `NO_ORACLE === true`, skip the Oracle call. Complex plan with `--no-oracle` runs only `ac:plan-code-deep-review`.

### 3c. Parse verdicts

Verdict markers to parse, in order of appearance in each reviewer's response:

- `ac:plan-code-review` and `ac:plan-code-deep-review`: look for the literal markdown `**APPROVED**` or `**BLOCKED**` under the response's final `## Verdict` section. The reviewer's output_format guarantees one of these two markers; anything else is malformed.
- `ac:oracle`: look for the literal line `VERDICT: APPROVED` or `VERDICT: BLOCKED` at the end of the response. The orchestrator's prompt to oracle (above) demands this exact line; if it is missing, treat the oracle response as malformed and retry the spawn once.

Aggregate verdicts:
- ALL `**APPROVED**` / `VERDICT: APPROVED` → exit revision loop, advance to Phase 4.
- ANY `**BLOCKED**` / `VERDICT: BLOCKED` → revision loop (3d below).
- Any malformed verdict → re-spawn that reviewer once; if malformed twice, treat as BLOCKED with the malformed output noted in the revision loop.

When a reviewer returns APPROVED but the response body includes notes about plan-spec mismatches (deferred / out-of-scope items the reviewer did not consider blocking), the verdict prevails: advance to Phase 4 and record the notes in the dev report's Notes section. Plan-spec issues only trigger the BLOCKER auto-mode halt when they appear in a BLOCKED reviewer's issue list (Phase 3d step 6).

### 3d. Revision loop (3 iter + stall detection)

If any reviewer returned BLOCKED:

1. Increment `CODE_REVIEW_ITER`.

2. **Max-iter terminal check FIRST**. If `CODE_REVIEW_ITER > 5`: (The target is 0 iter; per-step 4-layer verification should produce work that passes Phase 3 first time. The cap exists for the rare case the implementation needs cycles; past 5 iter, something is fundamentally off.)

   ```
   AskUserQuestion (header `Max iter?`, options
     `Proceed anyway (Recommended)` /
     `Stop and surface findings` /
     `Investigate manually`
   )
   ```

   - `Proceed anyway`: advance to Phase 4 with reviewer issues noted in the report.
   - `Stop and surface findings`: halt before Phase 4, print the unresolved findings, exit.
   - `Investigate manually`: same as Stop, but message says "user will investigate then re-run /ac:execute".

   **Auto mode**: this is auto-eligible (see `<auto_mode>`). When `AUTO_MODE = true`, skip the question, auto-pick `Proceed anyway (Recommended)`, emit one line: `Auto mode: code-review hit max-iter (>3); proceeding to Phase 4 with unresolved findings noted in report.` Proceed.

3. **Count blocking issues** across all reviewers (CRITICAL + IMPORTANT).

4. **Stall detection**. If `issue_count >= CODE_REVIEW_PREV_ISSUES` AND `CODE_REVIEW_ITER >= 2`:

   ```
   AskUserQuestion (header `Stalled?`, options
     `Proceed anyway (Recommended)` /
     `Stop and surface findings` /
     `Investigate manually`
   )
   ```

   First iteration cannot stall (`CODE_REVIEW_PREV_ISSUES` starts at `Infinity`).

   **Auto mode**: this is auto-eligible. When `AUTO_MODE = true`, skip the question, auto-pick `Proceed anyway (Recommended)`, emit one line: `Auto mode: code-review stalled at <N> issues (no improvement over iter <N-1>); proceeding to Phase 4 with unresolved findings noted in report.` Proceed.

5. Update `CODE_REVIEW_PREV_ISSUES = issue_count`.

6. **Apply fixes**. For each BLOCKED finding:
   - Read the affected file at the cited `file_path:line_number`.
   - Apply the smallest correct fix that addresses the finding. The reviewer's `Fix:` line is your guidance.
   - Use `Edit` for the fix.
   - If the finding is a plan-spec issue (the plan itself is wrong, not the implementation), do NOT silently revise the plan; surface via `AskUserQuestion` (`Plan-spec issue: <finding>. Options: Edit plan to fix and re-verify / Accept as Risk and proceed / Stop`).
   - **Auto mode**: the plan-spec branch is a BLOCKER call site (see `<auto_mode>`). Surface the `AskUserQuestion` to the user EVEN IF `AUTO_MODE = true`. Auto-rewriting the plan is unsafe; the user must judge whether the plan or the implementation should change. Before calling `AskUserQuestion`, emit one line: `BLOCKER: reviewer flagged a plan-spec issue at <file:line>. Auto mode halted; user judgment required.` Apply the user's response.

7. Re-run Phase 3a (build + test + lint) on the fixes.

8. Re-spawn the reviewer(s). Pass the same prompt; the reviewer reads the new state of the modified files. Loop to 3c.

### 3e. Convergence

When all reviewers return APPROVED (or user proceeds via escalation gate), exit the revision loop and advance to Phase 4.

TaskUpdate Phase 3 to `completed`, Phase 4 to `in_progress`.

## Phase 4: Deliver

Goal: commit the work, generate the dev report, render the execution summary.

### 4a. Final commit

**F7 skip-condition check** (run FIRST, before any commit invocation):

1. For each file in `MODIFIED_FILES`, run `git check-ignore -q <file>`. If ALL files exit 0 (every modified file is under a gitignored path), AND `git status --porcelain` shows tracked modifications NOT present in `MODIFIED_FILES` (parent repo has unrelated tracked work), the F7 case has fired: skip the final commit.
2. The plan's `## Execution Strategy` MAY declare a `Git context:` field (`root` | `gitignored-subproject` | `independent-git-init`); when present, honor it as a hint but still verify via git state (the field is advisory; git state is authoritative).
3. On F7 skip: emit one user-visible line `Auto mode: Phase 4 final commit → SKIPPED (F7 case: gitignored MODIFIED_FILES + parent repo unrelated tracked work)`. Log in the dev report (4b below) under `## Commits`: `Phase 4 final commit skipped — F7 case. MODIFIED_FILES are gitignored at <path>; parent repo has <N> unrelated tracked changes. /ac:commit would inadvertently snapshot unrelated work as this plan's deliverable. Plan's deliverables remain at their gitignored location; user can git add -f <path> to track them explicitly.` Advance to 4b without commit invocation.
4. If MODIFIED_FILES are tracked OR parent repo has no unrelated tracked changes, proceed to commit invocation below.

**Commit invocation** (when F7 skip-condition did NOT fire):

Invoke `/ac:commit --skip-preflight` via the Skill tool.

- `--skip-preflight` because Phase 2d per-step and Phase 3 code-review covered verification.
- No `--no-push` flag: this is the final commit; push if an upstream tracking branch exists.
- The `ac:git-master` skill (invoked by `/ac:commit`) handles atomic-commit splitting (3+ files → 2+ commits, etc.) and style detection from repo history.

If the working tree is clean (no changes to commit), `/ac:commit` exits silently; this is fine. The plan's changes were committed at wave-after checkpoints (complex plans) or made earlier without producing diff (rare).

### 4b. Generate dev report

Write `.ac/plans/<slug>/report.md` using the template at `${CLAUDE_SKILL_DIR}/references/report-template.md`. Fill placeholders with concrete values from the run (steps executed, modified files, verification outcomes, accumulated wisdom, notes, commit hashes).

After Write, verify the file landed: `Bash test -f .ac/plans/<slug>/report.md && wc -l .ac/plans/<slug>/report.md`. If absent or zero-length, retry Write once; if still failing, render the report inline to the user.

### 4c. Render execution summary

Render the closing summary inline using the template at `${CLAUDE_SKILL_DIR}/references/execution-summary-template.md`. Do not write to a file; report.md is the file artifact.

TaskUpdate Phase 4 to `completed`. End the turn.

## Error handling

- **Plan not found**: print `Plan not found at <path>. Run /ac:plan first.`, stop. No partial work.
- **Worker returns malformed output** (no Changes Made / Verification sections): re-spawn the same tier once with a format reminder. If still malformed, treat as Phase 2 failure (increments `VERIFY_RETRY_COUNT`).
- **Verification fails for a step that subsequent steps depend on**: do NOT continue to dependent waves. Stop the wave loop, surface via `AskUserQuestion` (`Step <N> is a hard dependency for Wave <M+1>. Fix manually and resume, or abort?`). BLOCKER in auto mode: surface even when `AUTO_MODE = true`; emit one line `BLOCKER: dependency-failed equivalent; auto mode halted.` Same semantic as Phase 2i.
- **Wave checkpoint commit fails** (git error, conflicts): print the git error, surface via `AskUserQuestion` (`Checkpoint commit failed: <error>. Continue without checkpoint / Abort`). Do not auto-retry; commit failures often hide deeper repo state issues. BLOCKER in auto mode: surface even when `AUTO_MODE = true`; commit failures usually mean the working tree is in an unexpected state and auto-continuing could lose work.
- **Final code-review reviewer subagent itself returns malformed**: re-spawn once with same prompt. If still malformed, treat as BLOCKED with the malformed output noted in the revision loop.
- **Plan-spec issue surfaced by reviewer** (the plan, not the code, is wrong): surface via `AskUserQuestion` as described in 3d step 6. Do not silently rewrite the plan.
- **`/ac:commit` (final, Phase 4) fails**: surface the failure, render the dev report and execution summary anyway (so the work is not lost in chat history), exit with the commit error printed.

## Reminders

Failure-mode anchors for execution:

- Auto-continue between steps and waves; do not ask for approval between verified steps.
- Read every changed file in Layer B (Manual Code Review). Skipping it is the most common quality miss.
- Copy worker briefing fields verbatim from the plan. Paraphrasing inverts opt-in/opt-out.
- Inject `TDD_MODE` directive into every worker briefing (`tdd` / `tests-after` / `none`).
- TaskUpdate each step and phase on entry and exit; the progress UI relies on it.
