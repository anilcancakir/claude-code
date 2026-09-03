# Worker Briefing Template (hybrid 6-section)

The briefing shape passed to every worker subagent (`ac:plan-worker-quick`, `-junior`, `-senior`) at Phase 2c. The briefing keeps the worker's CONTRACT fields VERBATIM from the plan (Description, Files, Done when, QA, Must NOT, paraphrasing these silently inverts opt-in/opt-out, the #1 worker failure mode). Auxiliary plan context (Pattern References, Codebase Conventions) is inlined into Section 6, because the worker no longer opens the plan. The briefing is longer for it and the ~8k tokens the worker used to spend re-reading the plan are not. Net savings scale with wave size and per-step References count.

## When to read this

Read in Phase 2c every time you spawn a worker. The fields marked VERBATIM are copied from the plan exactly; the fields marked DERIVED are computed by the orchestrator; fields marked PLAN-READ are NOT duplicated in the briefing because the worker Reads them from the plan file (referenced by path in Section 1).

## Template

```markdown
## 1. TASK

**Your Assignment**: Step <N>: <step title, VERBATIM>
**Overall Goal**: <plan title, one sentence> (DERIVED from plan frontmatter)

<step Description, VERBATIM from plan>

## 2. EXPECTED OUTCOME

**Files to Modify**: <plan step Files, VERBATIM>
**Done when**:
<plan step Done when, VERBATIM>

**QA**: <plan step QA, VERBATIM>
**Capture evidence to**: `.ac/plans/<slug>/evidence/<step-id>-<scenario>.<ext>` (DERIVED; the worker cannot
derive this itself now that it does not read the plan, and its report cites the path)

## 3. REQUIRED TOOLS

<DERIVED from step Files and QA. Examples:
- For code steps: Read, Edit, Write, Bash (test/build).
- For infra steps: Bash (SSH).
- For QA steps: playwright / curl / interactive_bash as the QA field specifies.>

## 4. MUST DO

- **Do NOT open the plan file.** Everything you need is in this briefing, which is why Section 6 carries the
  conventions, the references and the guardrails inline. The plan runs to tens of thousands of characters and you would be
  reading it to find the 1,000 that are already below.
- Follow CLAUDE.md conventions (already in your context).
- Follow the user's personal coding skill `my-coding` (preloaded into your context). Apply its rules to every file you touch.
- <TDD directive, INSERT one of these based on `TDD_MODE`:>
  - When `TDD_MODE === "tdd"`: `Write the failing test FIRST. Run it and confirm it fails for the right reason. THEN write the implementation that turns it green. Refactor if needed; do not skip the red phase.`
  - When `TDD_MODE === "tests-after"`: `For any behavioral change in this step, write a test that exercises the change AFTER you implement it. Tests run in CI; an implementation without a test for a behavioral change is incomplete.`
  - When `TDD_MODE === "none"`: omit the TDD line entirely. The step's `Done when` criterion may still mandate a test; honor that explicitly when present.
- **Stop on an internal contradiction**: if your assignment's `Description`, `Done when` or `QA` cannot be
  satisfied without violating your own `Must NOT` or the plan-wide guardrails in Section 6, STOP and report
  under `### Issues` with the literal tag `[CONTRADICTION]` and the shape of the conflict. Do not pragmatically
  violate the constraint to satisfy the criterion, and do not silently leave the criterion unsatisfied.
  Conflicts BETWEEN steps are not yours to detect any more: you no longer read the plan, so `ac:plan-reviewer`
  catches them before execution and the orchestrator resolves whatever survives at the wave barrier.
- **Report within-spec pragmatic deviations**: when your implementation deviates from the plan's EXACT prescription but stays within scope (added a defense-in-depth layer the plan did not specify; narrowed a config field; adjusted a snippet shape; introduced a small helper interface to fix a type-system gap), record each deviation in a `### Deviations` section of your Output using the structured 4-field format (Plan prescription / What I did / Why / Touches Must NOT). Within-spec adaptations driven by TDD red phase, framework-completeness gaps, type-system gaps, or library API quirks are encouraged, the orchestrator's Layer B reads this section to triage adaptation-vs-scope-drift transparently. **Crucial distinction**: if the deviation touches YOUR `Must NOT` or a plan-wide guardrail, that is a `[CONTRADICTION]` instead, use the previous bullet's tag and STOP. The Deviations section is for WITHIN-SPEC good-judgment adaptations only. When the implementation matches the plan EXACTLY (no deviation), omit the Deviations section entirely.
- After implementing, run the verification commands and report results in the Output Format.

## 5. MUST NOT DO

- Do NOT modify files outside the assignment's Files list.
- Do NOT add features beyond the step's Description.
- Do NOT skip or modify tests to make them pass.
- Do NOT add new dependencies unless the step explicitly authorizes them.
- <plan step Must NOT, VERBATIM>

## 6. CONTEXT

### Runtime Commands (DERIVED from CLAUDE.md)
<RUNTIME_CONTEXT if non-empty, build, test, lint commands>

### Wisdom from prior steps (DERIVED)
<ACCUMULATED_WISDOM if non-empty, items distilled in prior waves; prefer these over re-discovering>

### Dependencies (DERIVED)
<list of step IDs this step depends on (extracted from the plan's `## Execution Strategy` → `### Dependency Notes` section, or "None" when the step is wave-independent), and one line on what each produced. Omit this section entirely when there are no dependencies.>

### Depth and negative results (VERBATIM guidance)

State how deep the step needs the worker to go, and say what a negative result looks like. A subagent ships with its
own retrieval budget and a rigid report template, so a briefing that does not raise them explicitly gets back a thin
single-pass answer. "I read X, Y, Z and the pattern is not there" is a usable result and belongs under `### Issues`;
silence on a question the briefing asked is not.

### Pattern references (VERBATIM from the step's `References:` field)
<Every entry, with its `file_path:line_number` and the one line on what to follow there. Include the step's Reuse
Map entries and what each provides; a Reuse Map entry is an instruction to use the existing thing, not a hint.>

### Codebase conventions (VERBATIM from the plan's `## Codebase Conventions`)
<Every field the plan set, including Path aliases, TDD, the LSP false-positive whitelist and Test mount discipline
when present. Do not summarise; a paraphrased convention is a convention the worker will not follow exactly.>

### Invariants to preserve (DERIVED from the plan's `## Work Objectives`)
<The Core Objective in one line, plus any Must Have this step could break. This is what stops a locally-correct
change from breaking the thing the plan exists to deliver.>

### Plan-wide guardrails (VERBATIM from the plan's `## Must NOT Have`)
<The whole block. This is the anti-slop rule set: no scope inflation, no premature abstraction, no copy-paste with
variation, comments only where WHY is non-obvious, no documentation bloat, no over-validation on trusted inputs.
Without it inline, the worker sees no anti-slop rule at all, because it no longer reads the plan.>
```

## Length and verbatim discipline

The briefing keeps the worker's CONTRACT fields VERBATIM:
- Description (Section 1): what to do
- Files (Section 2): scope boundary
- Done when (Section 2): acceptance criterion
- QA (Section 2): verification scenario
- Must NOT (Section 5): anti-scope guardrails

Paraphrasing any of these silently flips opt-in/opt-out and is the most common worker failure mode. Pattern References, the Codebase Conventions, the Work Objectives invariants and the plan-wide guardrails are
INLINED into Section 6, verbatim. They used to be left to the worker to read out of the plan; it no longer
opens the plan, so anything not assembled here is unreachable.

The TDD directive is inserted based on the plan's `## Codebase Conventions` → `**TDD**` field, read once at Phase 1f and propagated to every worker briefing for the rest of the run.

## What the worker does on receipt

1. Read the briefing (this template populated). Note the step number in Section 1; there is no plan path to follow.
2. Read the target files named in `Files to Modify`.
3. Apply wisdom from Section 6.
4. Implement per the briefing's references and contract fields.
5. Run verification commands (Layer A: LSP + build + test).
6. Report in the Output Format the agent body specifies.
