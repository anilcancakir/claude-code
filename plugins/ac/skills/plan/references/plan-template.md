# Plan File Template

Copy-paste-ready markdown structure the planner writes to `.ac/plans/<slug>/plan.md` in Stage 5. The plan file is LLM-friendly: structured markdown, concrete `file_path:line_number`, parsable field labels, no prose flourish, no decorative narration. Downstream agents (`ac:plan-reviewer`, `/ac:execute`, plan-worker tier subagents) read it as a spec.

## When to read this

Read in Stage 5 (Plan Write) before calling `Write` on `PLAN_PATH`. Fill placeholders with concrete content. Remove placeholder text inside angle brackets when you write. For plans with more than 10 steps, use the incremental write protocol: one `Write` for the skeleton (every section except per-step bodies), then `Edit` calls inserting step batches of 2 to 4 before the `## Final Verification Wave` placeholder section. Calling `Write` twice on the same path erases the first call; use `Edit` for incremental appends.

## Complexity classification (sets the plan's `Complexity` field)

Before writing the plan, pick a value for the `Complexity` field in the plan's frontmatter. Stage 5.5 uses this value to route the review tier; the planner is the authoritative source.

- `simple` when ALL hold: 1-2 steps, single module, single-file or near-single-file change, no cross-cutting concerns, no architecture impact.
- `standard` when typical: 3-6 steps, 1-2 modules, contained scope, conventional implementation work. This is the default for most plans.
- `complex` when ANY hold: 7+ steps, 3+ modules crossed, cross-cutting concerns (auth, logging, error-handling boundaries, migrations), architecture impact (new patterns, new infrastructure, new dependency), or codebase state is `legacy` / `chaotic`.

Record the value in the plan frontmatter (`**Complexity**: <value>`). Stage 5.5a reads this field directly.

## Template

```markdown
# Plan: <Title>

**Complexity**: <simple | standard | complex>
**Steps**: <N>
**Waves**: <N>
**Codebase State**: <disciplined | transitional | legacy | chaotic | greenfield>
**Generated**: <ISO timestamp>

## Research Summary

- **Key Files**: file_path:line_number — one line per file
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
- **TDD**: <tdd | tests-after | none> — set in Stage 3 TDD interview; the executor's worker briefings honor this.
- **LSP false-positive whitelist**: <Class 2 symbols + structural pattern hints the executor's Phase 2d Layer A skips without retry. Two sub-fields:
  - **Symbols** (Class 2 autoload-registered globals): `it, uses, expect, beforeEach, pest, test` (Pest under intelephense P1010); `defineProps, defineEmits, defineExpose` (Vue compiler macros); `useFetch, useState, useRouter, useRoute` (Nuxt auto-imports); `describe, expect, vi` (Vitest auto-globals); etc.
  - **Patterns** (structural hints): `boundary` — declares the project is a sub-project under a larger repo (own `package.json` + `tsconfig.json`); outer-LSP module-resolution misses are Class 5 boundary noise, sub-project local tsc is authoritative. `matcher-chain` — declares the test files use `await expect(...).rejects.toX(...)` / `.resolves.toX(...)` patterns; TS infers chain as non-thenable and flags `'await' has no effect`; Class 6 false positive.

  Example value: `Symbols: it, uses, expect, beforeEach; Patterns: boundary, matcher-chain`.

  Omit this field entirely when the project's LSP produces no autoload-registered false positives and no sub-project/matcher-chain structural hints.>
- **Test mount discipline**: <when test infrastructure is present, ONE canonical pattern prescribed across all tests, plus banned APIs. State the mount factory (e.g., `mount(Component, { props, global: { plugins: [pinia] } })` from `@vue/test-utils`), the active-store setup (e.g., `setActivePinia(createPinia())` in `beforeEach`), the auto-import-mock pattern (e.g., `vi.mock('<module>', async (importOriginal) => ({ ...await importOriginal(), useX: vi.fn(...) }))`), and any broken APIs to NEVER use in this version combo (e.g., `mountSuspended` from `@nuxt/test-utils/runtime` is broken in Vitest 3 + @nuxt/test-utils 4.0.3). Apply to every test file; the banned-API list pre-empts workers re-discovering known breakage one file at a time. Omit this field entirely when the plan's TDD field is `none`.>

Extracted from Stage 2 deep read of files at <list of paths>. Every step honors these implicitly. Do not restate per step.

## Reuse Map

Existing code the plan leverages instead of writing new:

- file_path:line_number — <what it provides> — used by Step <N>
- file_path:line_number — <what it provides> — used by Step <N>

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
- <plan-specific exclusions surfaced during the interview>

## Tier Calibration

Rule of detail: write each step with enough context for the assigned model to act, and no more. If you find yourself prescribing line-by-line edits, the executor's job has migrated into the plan. The right tier is the one whose write-style fits the work without forcing line-level prescription.

| Tier    | Model                          | SWE-bench Verified | SWE-bench Pro | When to assign | Write style |
|---------|--------------------------------|--------------------|---------------|----------------|-------------|
| quick   | claude-haiku-4-5-20251001      | 73.3%              | 39.45%        | 1 file, mechanical: config edit, rename, scaffold, single-file fix | File path + 1-2 sentence outcome + optional pattern reference. No detail past "what to produce". |
| junior  | claude-sonnet-4-6              | 79.6%              | 49.8%         | 1-3 files, standard implementation, business logic, pattern application. The default tier. | Outcome + pattern reference (file:line) + Must NOT scope guardrails. Sonnet 4.6 reads broad context and avoids duplicating shared logic. |
| senior  | claude-opus-4-7                | 87.6%              | 64.3%         | 3+ files, cross-layer changes, architecture, migration, complex edges, self-verification | High-level intent + architectural constraint + cross-cutting concerns + acceptance criterion. Opus 4.7 designs the solution; do not prescribe low-level code. |

Codebase state escalation: when `Codebase State` is `legacy` or `chaotic`, escalate every `quick` step to `junior` and record the escalation in `## Research Summary`. Mechanical work in a chaotic codebase is not mechanical; context is required.

Criticality escalation: when a step touches a security-critical or correctness-critical surface — authentication / authorization (login, password reset, session, token, RBAC, RLS, Policy / Gate, OAuth), payment / billing / financial calculation (currency math, charge, refund, ledger), cryptographic operations (hash, sign, verify, encrypt, JWT, HMAC, password hashing), user-input → SQL / shell / file path (injection or traversal surface), file upload / deserialization (RCE surface), migration with destructive operations (DROP, TRUNCATE, schema rename with data loss) — escalate the tier by one level (quick → junior, junior → senior). Sonnet 4.6 vs Opus 4.7's subtle-bug delta widens on these surfaces; Opus performs more self-verification on security logic. Failure mode is asymmetric: a silent auth bypass or financial drift ships and is expensive to find post-deploy. Codebase-state escalation and criticality escalation stack independently. Record any criticality escalation in `## Research Summary` alongside any codebase-state escalation.

Anti-patterns per tier (each example is a bad step; the rewrite shows the correct shape):

- quick — bad: `"Open foo.ts at line 42, change let x = 1 to let x = 2."` Haiku does this without you describing it. Write `"Update the timeout default to 30s in foo.ts."` and stop.
- junior — bad: `"Wrap every call site with try { ... } catch (e) { logger.error(e); throw new ApiError(e); }"`. Sonnet 4.6 infers handlers from existing code. Write `"Add error handling on the user-input boundary in handlers/users.ts; follow the pattern at handlers/auth.ts:88."`.
- senior — bad: `"First create A, then B imports A, then C imports B, then D imports C."` Opus 4.7 designs the order. Write `"Implement event-driven dispatch matching the pattern at dispatcher/core.ts:142; preserve the at-least-once delivery invariant."`.

## Execution Strategy

### Parallel Execution Waves

Each wave completes before the next begins. Sensible parallelism within a wave: steps share NO files, NO in-flight type contracts, NO behavioral coupling — AND each step is a meaningful unit of work. Do not split a conceptually-tight unit (a model + its tests, a config + its sole consumer in the same file) into multiple steps just to inflate wave size; coherence beats arbitrary parallelism. A 1-step wave is correct when the step is genuinely the only thing at its depth (e.g., a foundation Step 1 that downstream depends on). A 6+ step wave is correct when N truly independent tracks exist (e.g., N independent UI components). Target efficient parallelism, not maximum parallelism.

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

Step types (the `Type:` field per step):
- `code` — source code edits in the project. Requires Tier + worker spawn.
- `infra` — server ops, SSH, deployment, multi-host orchestration. Requires Tier + worker spawn.
- `verification` — runs commands and captures output as evidence; no source edits. Orchestrator-direct execution (no worker spawn), so Tier and Why-this-tier are omitted. Use for build-output smoke, dev-server checks, browser-driven UI confirmation, end-to-end test runs. Layer A blends with the orchestrator's direct Bash execution; Layer C is the captured evidence; Layer D applies.

- [ ] **Step 1**: <imperative title>
    - **Type**: code | infra | verification
    - **Tier**: quick | junior | senior (omit when Type is verification)
    - **Why this tier**: <one sentence> (omit when Type is verification)
    - **Files**: <absolute paths, one per line; for verification: "(no source edits; runs commands)">
    - **Description**: <what to do and why, grounded in research>
    - **References**:
        - file_path:line_number — <pattern to follow>
        - <Reuse Map entry> — <how this step uses it>
    - **Commands**: <verification steps only: explicit command list to run, one per line>
    - **Done when**:
        - <executable criterion: greppable, testable, or LSP-checkable>
    - **QA**: <tool + steps + expected result>
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

## After writing the plan file

1. Verify the file exists and is non-trivial: `Bash test -f <PLAN_PATH> && wc -l <PLAN_PATH>`. If absent, zero-length, or under 60 lines, retry the write once. If the retry also fails, call `AskUserQuestion` (header `Write fail?`, options `Retry once more` / `Dump synthesis inline` / `Abandon`). This is a BLOCKER call site in auto mode: surface to the user even when `AUTO_MODE = true`.
2. Append a final entry to `LOG_PATH` summarizing the plan write (wave count, step count, tier distribution).
3. Do NOT delete `CHECKPOINT_PATH` yet. Stage 5.5 may revise the plan and needs resume state intact. Checkpoint deletion happens in Stage 6.
