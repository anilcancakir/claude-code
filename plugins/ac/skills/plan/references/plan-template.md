# Plan File Template

Copy-paste-ready markdown structure the planner writes to `.ac/plans/<slug>/plan.md` in Stage 5. The plan file is LLM-friendly: structured markdown, concrete `file_path:line_number`, parsable field labels, no prose flourish, no decorative narration. Downstream agents (`ac:plan-reviewer`, `/ac:execute`, plan-worker tier subagents) read it as a spec.

## When to read this

Read in Stage 5 (Plan Write). Stage 5 opens by running `plan-scaffold`, which writes the skeleton below with every section heading already in order, so the planner fills it in with `Edit` rather than `Write`. A `Write` on `PLAN_PATH` would erase the scaffolded skeleton, and a second `Write` erases the first call's output as well; `Edit` is the only safe verb here. Fill placeholders with concrete content and remove the placeholder text inside angle brackets. For plans with more than 10 steps, insert step bodies in batches of 2 to 4 rather than one enormous edit.

## When a plan is too large to be one plan

The plan file's size stopped being free at the moment the worker stopped reading it. Workers now receive an assembled briefing rather than the file, so plan size no longer multiplies across every spawn, but it is still admitted once into the executor's context and read by the reviewer. Keep the per-step Description targets above and the file follows.

The binding constraint is review coverage, because the reviewer runs once and caps its report at 25 findings. So: when a plan would exceed 20 steps or 6 waves, split it into a sequence of independently executable plans rather than writing one oversized plan. Each plan in the sequence carries its own Definition of Done, its own verification wave, and its own review cycle, and the sequence order is recorded in each plan's Dependency Notes so the operator knows what runs next. Splitting is about reviewability and run length, never about file size.

## Template

```markdown
# Plan: <Title>

**Steps**: <N>
**Waves**: <N>
**Codebase State**: <disciplined | transitional | legacy | chaotic | greenfield>
**Auto mode**: <true | false, written by `plan-scaffold --auto-mode` from the Stage 4 answer; Stage 6a reads it>
**Generated**: <ISO timestamp>

## Research Summary

- **Key Files**: file_path:line_number, one line per file
- **Patterns Found**: <architecture, naming, style observed in scope>
- **External References**: <official docs, OSS patterns from librarian, with URL>
- **Tier Escalation**: <"None" or "All quick steps escalated to junior due to codebase state X">

## Codebase Conventions

- **Naming**: <pattern>
- **Error handling**: <style>
- **Comment density**: <level>
- **Type discipline**: <level>
- **File organization**: <pattern>
- **Import convention**: <pattern>
- **Path aliases**: <explicit alias resolution rules for the framework and the project's path conventions. State the alias → directory mapping AND name any common mis-form to avoid. Example for Nuxt 4: `~/X` resolves to `<srcDir>/X`; NEVER write `~/app/X` because it doubles the prefix (build error: `Could not load app//app/...`). Test runners may resolve aliases more leniently than the production build; the build is authoritative. Configs at project root use the same rules. Apply to every import in every file; do not let workers re-derive per step.>
- **TDD**: <tdd | tests-after | none>. Set in the Stage 3 TDD interview; the executor's worker briefings honor this.
- **LSP false-positive whitelist**: <Class 2 symbols + structural pattern hints the executor's Phase 2d Layer A skips without retry. Two sub-fields:
  - **Symbols** (Class 2 autoload-registered globals): `it, uses, expect, beforeEach, pest, test` (Pest under intelephense P1010); `defineProps, defineEmits, defineExpose` (Vue compiler macros); `useFetch, useState, useRouter, useRoute` (Nuxt auto-imports); `describe, expect, vi` (Vitest auto-globals); etc.
  - **Patterns** (structural hints): `boundary`: declares the project is a sub-project under a larger repo (own `package.json` + `tsconfig.json`); outer-LSP module-resolution misses are Class 5 boundary noise, sub-project local tsc is authoritative. `matcher-chain`: declares the test files use `await expect(...).rejects.toX(...)` / `.resolves.toX(...)` patterns; TS infers chain as non-thenable and flags `'await' has no effect`; Class 6 false positive.

  Example value: `Symbols: it, uses, expect, beforeEach; Patterns: boundary, matcher-chain`.

  Omit this field entirely when the project's LSP produces no autoload-registered false positives and no sub-project/matcher-chain structural hints.>
- **Test mount discipline**: <when test infrastructure is present, ONE canonical pattern prescribed across all tests, plus banned APIs. State the mount factory (e.g., `mount(Component, { props, global: { plugins: [pinia] } })` from `@vue/test-utils`), the active-store setup (e.g., `setActivePinia(createPinia())` in `beforeEach`), the auto-import-mock pattern (e.g., `vi.mock('<module>', async (importOriginal) => ({ ...await importOriginal(), useX: vi.fn(...) }))`), and any broken APIs to NEVER use in this version combo (e.g., `mountSuspended` from `@nuxt/test-utils/runtime` is broken in Vitest 3 + @nuxt/test-utils 4.0.3). Apply to every test file; the banned-API list pre-empts workers re-discovering known breakage one file at a time. Omit this field entirely when the plan's TDD field is `none`.>

Extracted from Stage 2 deep read of files at <list of paths>. Every step honors these implicitly. Do not restate per step.

## Reuse Map

Existing code the plan leverages instead of writing new:

- file_path:line_number, <what it provides>: used by Step <N>
- file_path:line_number, <what it provides>: used by Step <N>

If a step proposes new code that overlaps with an entry here, the plan needs revision before write: rework the affected step to use the Reuse Map entry, or surface the overlap as a Risk Accepted with explicit rationale.

## Work Objectives

### Core Objective
<1-2 sentences, falsifiable: what we are achieving>

### Concrete Deliverables
- <exact file / endpoint / feature / behavior>

### Definition of Done
- <verifiable condition with command or check>

### Must Have
- <non-negotiable requirement>

### Must NOT Have (Plan-Wide Guardrails)
- No scope inflation: changes touch only the files listed in steps.
- No premature abstraction: a utility extraction requires 3+ concrete callers.
- No copy-paste with slight variation.
- Comments only when WHY is non-obvious; no decorative docstrings.
- No documentation bloat: no unrequested READMEs, no inline narration.
- No over-validation on trusted internal inputs.
- No backwards-compatibility shims unless explicitly required.
- Framework completeness: when a Step declares a controller, model, resource, or component that the framework expects to ship with a known shape, the Step's Description AND Files list must enumerate every shape the framework will invoke at runtime. Worked examples: Laravel `Route::resource` expects 7 methods (`index`, `show`, `create`, `store`, `edit`, `update`, `destroy`) and a missing `create()` returns `BadMethodCallException` when `/posts/create` is hit; Rails resourceful controller expects 7 actions; a Vue SFC requires `<template>` plus either `<script setup>` or `<script>` exporting a component; a Django `ModelViewSet` requires `queryset` + `serializer_class` at minimum; an Eloquent model with `Route::resource` route-binding needs `getRouteKeyName()` when the binding column is not `id`. The planner enumerates these in the step Description so workers cannot ship a subset.
- Invocation reachability: a step whose Description tells the executor to run a slash command has to name one the executor can actually invoke. A component whose frontmatter carries `disable-model-invocation: true` is excluded from the model's own list by design, so it can only be typed by the user. Check the frontmatter rather than the file: the creator skills discuss the flag in their bodies without setting it, so a plain `grep -l` over the file names them falsely. Read the block between the first two `---` lines. In this plugin only `/ac:init-project` and `/ac:install` set it. When a step needs one anyway, write it as a `verification` step whose Description says the user types the command and the step's `Commands` are the checks that run afterwards, rather than as an instruction the orchestrator cannot follow. Measured: a plan asked for a real `/ac:init-project` run and the step could not be executed as written, only worked around.
- <plan-specific exclusions surfaced during the interview>

## Tier Calibration

Rule of detail: write each step with enough context for the assigned model to act, and no more. If you find yourself prescribing line-by-line edits, the executor's job has migrated into the plan. The right tier is the one whose write-style fits the work without forcing line-level prescription.

| Tier    | Model                          | SWE-bench Verified | SWE-bench Pro | FrontierBench v0.1 | When to assign | Write style |
|---------|--------------------------------|--------------------|---------------|--------------------|----------------|-------------|
| quick   | claude-haiku-4-5-20251001      | 73.3%              | not reported  | not reported       | 1 isolated file, mechanical: config edit, rename, scaffold, single-file fix. No effort parameter exists on this model, so scope the work through the briefing. | File path + 1-2 sentence outcome + optional pattern reference. No detail past "what to produce". |
| junior  | claude-sonnet-5                | 85.2%              | 63.2%         | 17%                | Standard implementation, business logic, pattern application, multi-file pattern work. The default tier on speed and cost, but NOT a near-peer on the hardest cases; see the gap note below. | Outcome + pattern reference (file:line) + Must NOT scope guardrails. Sonnet 5 reads broad context and avoids duplicating shared logic. |
| junior-high | claude-sonnet-5           | 85.2%              | 63.2%         | 17%                | Junior-shaped work at the borderline of coupling or context depth, or lifted there by codebase state. Same model as junior at high effort, so a borderline step has somewhere to go that is not Opus. Sourced from rules 1-3 only; the criticality rule never routes here. | Same as junior. The extra effort buys thoroughness, not a different write style. |
| senior  | claude-opus-5-5 (`opus`)       | not reported       | 89.9%         | not reported       | Genuinely cross-layer changes, architecture, migration, long-horizon or critical work, complex edges, self-verification | High-level intent + architectural constraint + cross-cutting concerns + acceptance criterion. Opus designs the solution; do not prescribe low-level code. State the Files list as a hard boundary, because this tier widens scope more readily. |

Gap note: Opus 5.5 scores 89.9% on SWE-bench Pro against Sonnet 5's 63.2% (each from its own system card); on Opus 5's card, Opus 5 already led Sonnet 5 by about 16 points on Pro and 27 on FrontierBench v0.1 on the same harness. The 5.5 card reports no SWE-bench Verified or FrontierBench v0.1 figure. An earlier revision of this template treated Sonnet as near-Opus, which was true against Opus 4.8 (a ~6-point Pro gap) and is no longer true. Terminal-Bench is absent from this table on purpose: the harness changed twice in one generation, so cross-model Terminal-Bench comparisons are invalid. Full provenance in `model-tiers.md`.

The five numbered assignment rules and the two escalation rules live in `model-tiers.md` and are not restated here, because two copies drift and the copy in this file was the one that drifted: it said criticality fires when a step "touches" a security surface, which is the wording that put half of every recent plan's steps on senior. Read `model-tiers.md` before assigning tiers, and record any escalation in `## Research Summary`.

The one thing worth repeating, because it is the most expensive decision in the file: senior costs **5.9x junior per step**, measured across 367 worker runs. Criticality escalation fires when a step DECIDES security-relevant behaviour, not when it touches a file in that area. A step that can satisfy its own `Done when` without altering a security-relevant decision does not qualify.

Every non-verification step's `Done when` carries at least one criterion a single sub-60-second command can prove, so the wave barrier confirms it by running something rather than by reading prose. When the surface has no such command (no test file, no build target, no lint rule), say so in `Done when` and add a Wave-0 step that creates the harness before that step's wave runs. The reviewer flags a step with no provable criterion as IMPORTANT and the orchestrator decides.

**A criterion has to be able to fail.** Before a command goes into `Done when`, run it against an input you know is bad and confirm it reports the failure. A gate that cannot fail reports a pass, which is worse than no gate because it looks like verification. Two ways this happens, both measured here. A tool that does not support the flag you gave it exits non-zero with an empty stdout, and "returns nothing" then reads as clean: `grep -P` on macOS exits 2 and prints nothing, so an em-dash gate written that way passed on a file full of em-dashes, and `rg` was the fix. And a criterion can be checked against the wrong thing: a command ending in `head` truncates before the value it claims to assert appears. Write the assertion into the command rather than into the prose around it.

**A criterion that names a number gets read against the fixture in the same step.** A step once required a generated file of 60 to 200 lines while its own Description prescribed a three-line project to generate it from; the honest output was 33 lines, and padding it to clear the floor would have broken the very principle the generator exists to enforce. The criterion was the thing that was wrong. When a `Done when` states a size, a count or a duration, check it against the input the step itself sets up before the plan is written, and prefer a quality test with a hard cap over a fixed floor.

Anti-patterns per tier (each example is a bad step; the rewrite shows the correct shape):

- quick, bad: `"Open foo.ts at line 42, change let x = 1 to let x = 2."` Haiku does this without you describing it. Write `"Update the timeout default to 30s in foo.ts."` and stop.
- junior, bad: `"Wrap every call site with try { ... } catch (e) { logger.error(e); throw new ApiError(e); }"`. Sonnet 5 infers handlers from existing code. Write `"Add error handling on the user-input boundary in handlers/users.ts; follow the pattern at handlers/auth.ts:88."`.
- senior, bad: `"First create A, then B imports A, then C imports B, then D imports C."` Opus designs the order. Write `"Implement event-driven dispatch matching the pattern at dispatcher/core.ts:142; preserve the at-least-once delivery invariant."`.

## Execution Strategy

### Parallel Execution Waves

Each wave completes before the next begins. Sensible parallelism within a wave: steps share NO files, NO in-flight type contracts, NO behavioral coupling, AND each step is a meaningful unit of work. Do not split a conceptually-tight unit (a model + its tests, a config + its sole consumer in the same file) into multiple steps just to inflate wave size; coherence beats arbitrary parallelism. A 1-step wave is correct when the step is genuinely the only thing at its depth (e.g., a foundation Step 1 that downstream depends on). A 6+ step wave is correct when N truly independent tracks exist (e.g., N independent UI components). Target efficient parallelism, not maximum parallelism.

Single-file chain check, applied before you commit to the wave list: when three or more consecutive steps write the SAME file and each depends on the one before it, that is one unit somebody split, not a wave. Merge them into a single step at the highest tier among the merged links, and let the worker sequence the work internally. Merging does not itself raise the tier: three `quick` links merge into one `quick` step, because the merged step is the same mechanical work in one place rather than three. Re-apply the tier rules to the merged step only if merging genuinely changed its shape. A wave whose steps must run in a declared order is a chain wearing a wave's name, and it pays the spawn, the cold re-read of the plan and the file, and the full 4-layer verification once per link. Measured on one plan: three senior steps chained on one 900-line class took 72 minutes, 32% of the whole execution, with 17 of those minutes spent between the steps rather than inside them. The rule against splitting a conceptually-tight unit is above; this is the same rule pointed at a unit that is already split.

- Wave 0 (optional, ahead of Wave 1): scaffold steps that exist so a later step's `Done when` has a real command to run, for example an empty test file with the harness wired.
- Wave 0 or Wave 1, required when the plan's core mechanism is a network, IO, subprocess, or multi-row data seam: a real-seam harness step. It stands up the actual instrument the later steps' QA runs against, a loopback listener that asserts on the wire, a fixture seeded with the production row count, a temp server the client really connects to. `Http::fake` and a one-row fixture cannot reach the class of defect these seams produce, and deferring the proof to the final verification wave finds it after every step is already committed. Measured on one plan: four CRITICAL defects survived 14 steps of per-step 4-layer verification and surfaced only at the final code review, and every one of them needed either a real socket or a multi-row seeded catalog to see. One of them, a proxy's `CONNECT` reply being read as the target's response, would have published "we reached it normally" for every HTTPS check while sending the target zero bytes.
- Wave 1: foundation and scaffolding (types, schemas, shared utilities, configs). Often a small wave of 1-3 foundational steps that downstream depends on; install/dependency steps belong here AND downstream Wave 1 step QAs must not depend on their output (run independent checks instead, or move install to a dedicated Wave 0).
- Wave 2+: implementation building on Wave 1 outputs. Group by independence, not by step count.
- Wave FINAL: verification and review. Defined in the next phase; placeholder section below.

### Dependency Notes

<inline dependencies between waves and steps, or "None">

### Git context (optional)

<one of `root | gitignored-subproject | independent-git-init`, or omit when default `root` applies. The executor's Phase 4a reads this field as a hint:
- `root` (default when omitted): project files tracked at repo root; Phase 4 final commit follows normal flow.
- `gitignored-subproject`: project lives under a gitignored path (e.g. `references/<slug>/` when `references/` is in .gitignore). Phase 4 final commit will be auto-skipped per the F7 rule when the parent repo has unrelated tracked work; the plan's deliverables remain at the gitignored location.
- `independent-git-init`: project intended to have its own `git init` separate from the outer repo. Phase 4 commit responsibility is on the user; the orchestrator does not auto-init.>


## Steps

`ac plan-check <slug>` validates this section mechanically and is the Stage 5 gate. It reads the `- [ ]` line, the
`Type` value, `Tier` on worker steps, and `Commands` plus `Evidence` on verification steps, so those five are the
fields where drift costs a run rather than a reader.

Step types (the `Type:` field per step):
- `code`: source code edits in the project. Requires Tier + worker spawn.
- `infra`: server ops, SSH, deployment, multi-host orchestration. Requires Tier + worker spawn.
- `verification`: runs commands and captures output as evidence; no source edits. Orchestrator-direct execution (no worker spawn), so Tier and Why-this-tier are omitted. Use for build-output smoke, dev-server checks, browser-driven UI confirmation, end-to-end test runs. Layer A blends with the orchestrator's direct Bash execution; Layer C is the captured evidence; Layer D applies.

- [ ] **Step 1**: <imperative title>
    - **Type**: code | infra | verification
    - **Tier**: quick | junior | junior-high | senior (omit when Type is verification)
    - **Why this tier**: <`rule-1-cross-layer` | `rule-2-context` | `rule-3-codebase-state` | `rule-4-detail` | `rule-5-criticality` | `rule-none`, then a colon and one sentence. `rule-5-criticality` takes the before-and-after form: `before <X>, after <Y>`, both halves concrete. `rule-none` names a risk no numbered rule covers and routes to `junior-high`, never `senior`. See `model-tiers.md`.> (omit when Type is verification)
    - **Files**: <absolute paths, one per line; for verification: "(no source edits; runs commands)">
    - **Description**: <what to do and why, grounded in research. Must stand alone: the worker receives this
      field and never sees another step, so name a path or a `file:line` rather than "Step 4's parser".
      Target 400 characters for `quick`, 450 for `junior` and `junior-high`, 800 for `senior`. Name the change and the
      reason, cite the pattern by `file:line`, and stop. Measured, Descriptions averaged 1,100 characters and were
      39% of the whole plan file; the worker needs the spec, not the narration.>
    - **References**:
        - file_path:line_number, <pattern to follow>
        - <Reuse Map entry>: <how this step uses it>
    - **Commands**: <verification steps only: explicit command list to run, one per line>
    - **Done when**:
        - <executable criterion: greppable, testable, or LSP-checkable. At least one criterion per step must be
          provable by a single command that completes in under 60 seconds, so the wave barrier can confirm the step
          without reading prose. When no such command exists for the surface, say so here and add a Wave-0 step that
          creates the harness before this step's wave runs.>
    - **QA**: <tool + concrete steps (named selectors/endpoints/commands/data) + exact expected assertion; reproducer-validity where applicable: one command, fails on HEAD, deterministic>
    - **Evidence**: <verification steps only: paths under `.ac/plans/<slug>/evidence/<step-id>-<scenario>.<ext>` to capture output to>
    - **Must NOT**:
        - <step-specific scope exclusion>
        - <anti-slop guardrail relevant to this step>

- [ ] **Step 2**: ...

Steps within a wave must not share files, in-flight type contracts, or behavioral coupling. Repeat the field shape per step.

## Risks Accepted

Decisions kept in scope with a recommended default rather than a user-locked choice. Each entry includes the default and why it was accepted.

- <decision and recommended default>: <reason for acceptance, link to interview-log node>

## Cross-Project Observations

Findings that surfaced during planning or execution of THIS plan but apply to OTHER projects / sibling sub-projects in this repo. Each entry names: the observation, the target `file_path:line_number` in the sibling, and the suggested follow-up. These are NOT in this plan's scope; they are flags for the operator to spin off a separate plan when ready.

Sources of cross-project observations:
- Stage 3.5 oracle findings that explicitly mention applicability to a sibling project (same pattern, different package).
- Worker `### Deviations` reports (F17) that adapt a sibling pattern AND identify that the sibling has the same gap.
- Layer B Manual Code Review cross-file consistency checks that surface a same-pattern bug in a sibling.

Omit this section when there are no cross-project observations.

- <observation>: applies to `<sibling-project-path>/<file>:<line>`. Suggested follow-up: `/ac:plan <topic-for-sibling-fix>`.

## Deferred Ideas

Captured during the interview as out of scope for this plan. The backlog.

- <idea>: <reason deferred>
```

## Literal-pattern audit: worked example

The Stage 5 rule is in the skill body. This is the class of bug it finds, so you know what to look for.

A step's Description names the sanitizer regex `\]\(scheme:[^)]*\)`. The same step's QA lists the input `[x](javascript:alert(1))`. Run one against the other: `[^)]*` is greedy up to the first `)`, which is the inner paren closing `alert(1`, so the match ends there and the outer `)` falls outside it. The replacement produces `[x](#sanitized-link))` with a trailing paren, and the sanitizer looks like it worked.

Nothing about the regex reads as wrong, and nothing about the test input reads as tricky. Only running the one against the other surfaces it. That is the whole audit: for every literal paired with a concrete input, do the substitution by hand before the plan is written.

## After writing the plan file

1. Verify the file exists and is non-trivial: `Bash test -f <PLAN_PATH> && wc -l <PLAN_PATH>`. If absent, zero-length, or under 60 lines, retry the write once. If the retry also fails, call `AskUserQuestion` (header `Write fail?`, options `Retry once more` / `Dump synthesis inline` / `Abandon`). This is a BLOCKER call site in auto mode: surface to the user even when `AUTO_MODE = true`.
2. Append a final entry to `LOG_PATH` summarizing the plan write (wave count, step count, tier distribution).
3. Do NOT delete `CHECKPOINT_PATH` yet. Stage 5.5 may revise the plan and needs resume state intact. Checkpoint deletion happens in Stage 6.
