# Worker Briefing Template (hybrid 6-section)

The briefing shape passed to every worker subagent (`ac:plan-worker-quick`, `-junior`, `-senior`) at Phase 2c. The briefing keeps the worker's CONTRACT fields VERBATIM from the plan (Description, Files, Done when, QA, Must NOT — paraphrasing these silently inverts opt-in/opt-out, the #1 worker failure mode). Auxiliary plan context (Pattern References, Codebase Conventions) is externalized: the worker reads the plan directly for those, which saves ~10-20 lines per briefing without losing fidelity. Net savings scale with wave size and per-step References count.

## When to read this

Read in Phase 2c every time you spawn a worker. The fields marked VERBATIM are copied from the plan exactly; the fields marked DERIVED are computed by the orchestrator; fields marked PLAN-READ are NOT duplicated in the briefing because the worker Reads them from the plan file (referenced by path in Section 1).

## Template

```markdown
## 1. TASK

**Plan**: <PLAN_PATH> (DERIVED — pass the absolute path the orchestrator has)
**Your Assignment**: Step <N> — <step title, VERBATIM>
**Overall Goal**: <plan title, one sentence> (DERIVED from plan frontmatter)

<step Description, VERBATIM from plan>

## 2. EXPECTED OUTCOME

**Files to Modify**: <plan step Files, VERBATIM>
**Done when**:
<plan step Done when, VERBATIM>

**QA**: <plan step QA, VERBATIM>

## 3. REQUIRED TOOLS

<DERIVED from step Files and QA. Examples:
- For code steps: Read, Edit, Write, Bash (test/build).
- For infra steps: Bash (SSH).
- For QA steps: playwright / curl / interactive_bash as the QA field specifies.>

## 4. MUST DO

- **Before any code change**, Read the plan at `<PLAN_PATH>`. Locate Step <N>. Read its `References:` field (pattern references at file_path:line_number + Reuse Map entries) AND the plan's `## Codebase Conventions` section. Apply both throughout your work. The briefing does not duplicate these because the plan is the canonical source; treat the plan as authoritative.
- Follow CLAUDE.md conventions (already in your context).
- Follow the user's personal coding skill `my-coding` (preloaded into your context). Apply its rules to every file you touch.
- <TDD directive — INSERT one of these based on `TDD_MODE`:>
  - When `TDD_MODE === "tdd"`: `Write the failing test FIRST. Run it and confirm it fails for the right reason. THEN write the implementation that turns it green. Refactor if needed; do not skip the red phase.`
  - When `TDD_MODE === "tests-after"`: `For any behavioral change in this step, write a test that exercises the change AFTER you implement it. Tests run in CI; an implementation without a test for a behavioral change is incomplete.`
  - When `TDD_MODE === "none"`: omit the TDD line entirely. The step's `Done when` criterion may still mandate a test; honor that explicitly when present.
- **Detect cross-step contradictions and stop**: if your assignment's `Description` / `Done when` / `QA` cannot be satisfied without violating a `Must NOT` constraint (yours, OR another step's that you can see from the plan you read in the first MUST DO bullet), STOP and report under `### Issues` with the literal tag `[CROSS-STEP CONTRADICTION]` followed by the conflict shape. Example: "Done when requires `PostController.create()` to render the create form, but Step 7 owns `app/Http/Controllers/PostController.php` and its `Must NOT` forbids modifications from this step". Do not pragmatically violate the Must NOT to satisfy the Done when; do not silently leave the Done when unsatisfied either. The orchestrator handles cross-step contradictions at wave-end via Layer B remediation; your job ends at the report.
- **Report within-spec pragmatic deviations**: when your implementation deviates from the plan's EXACT prescription but stays within scope (added a defense-in-depth layer the plan did not specify; narrowed a config field; adjusted a snippet shape; introduced a small helper interface to fix a type-system gap), record each deviation in a `### Deviations` section of your Output using the structured 4-field format (Plan prescription / What I did / Why / Touches Must NOT). Within-spec adaptations driven by TDD red phase, framework-completeness gaps, type-system gaps, or library API quirks are encouraged — the orchestrator's Layer B reads this section to triage adaptation-vs-scope-drift transparently. **Crucial distinction**: if the deviation touches a Must NOT (yours or another step's), that is a CROSS-STEP CONTRADICTION instead — use the previous bullet's tag and STOP. The Deviations section is for WITHIN-SPEC good-judgment adaptations only. When the implementation matches the plan EXACTLY (no deviation), omit the Deviations section entirely.
- After implementing, run the verification commands and report results in the Output Format.

## 5. MUST NOT DO

- Do NOT modify files outside the assignment's Files list.
- Do NOT add features beyond the step's Description.
- Do NOT skip or modify tests to make them pass.
- Do NOT add new dependencies unless the step explicitly authorizes them.
- <plan step Must NOT, VERBATIM>

## 6. CONTEXT

### Runtime Commands (DERIVED from CLAUDE.md)
<RUNTIME_CONTEXT if non-empty — build, test, lint commands>

### Wisdom from prior steps (DERIVED)
<ACCUMULATED_WISDOM if non-empty — items distilled in prior waves; prefer these over re-discovering>

### Dependencies (DERIVED)
<list of step IDs this step depends on (extracted from the plan's `## Execution Strategy` → `### Dependency Notes` section, or "None" when the step is wave-independent), and one line on what each produced. Omit this section entirely when there are no dependencies.>

### Plan-read fields (NOT duplicated in this briefing)
- Pattern References — at the plan's Step <N> `References:` field.
- Codebase Conventions — at the plan's `## Codebase Conventions` section.
```

## Length and verbatim discipline

The briefing keeps the worker's CONTRACT fields VERBATIM:
- Description (Section 1) — what to do
- Files (Section 2) — scope boundary
- Done when (Section 2) — acceptance criterion
- QA (Section 2) — verification scenario
- Must NOT (Section 5) — anti-scope guardrails

Paraphrasing any of these silently flips opt-in/opt-out and is the most common worker failure mode. Pattern References and Codebase Conventions are externalized to plan Read because they are structural (not interpretive); the worker fetches them directly when applying patterns.

The TDD directive is inserted based on the plan's `## Codebase Conventions` → `**TDD**` field, read once at Phase 1f and propagated to every worker briefing for the rest of the run.

## What the worker does on receipt

1. Read briefing (this template populated). Note the `Plan` path and step number in Section 1.
2. Read the plan file at the given path; locate the step number; read its `References:` field and the plan's `## Codebase Conventions` section (+ `## Reuse Map` for any leveraged utilities).
3. Read the target files named in `Files to Modify`.
4. Apply wisdom from Section 6.
5. Implement per the plan's References + the briefing's contract fields.
6. Run verification commands (Layer A: LSP + build + test).
7. Report in the Output Format the agent body specifies.
