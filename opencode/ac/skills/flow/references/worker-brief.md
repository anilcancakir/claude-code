<!-- ported-from: plugins/ac/skills/flow/references/worker-brief.md sha256:fd5d8cc0828f2414069a9335d83f88b7c4feafa96276926fdc8355650498b3bf -->
# Worker briefing for flow

The briefing passed to `ac/plan-worker-quick`, `-junior`, `-junior-high` and `-senior` when the `flow` skill builds a slice. It is the six-section shape the worker bodies expect (the same one `/ac/execute` sends), cut down to what a slice has: there is no plan file, so nothing is copied from one. A worker reads only this briefing, so a missing fact is a `[BRIEFING GAP]` and a wasted spawn.

Section names stay as written; the worker bodies refer to them by name. Write the Description once per slice from its goal and the research. Copy Files and Done when from the slice table without paraphrase, because a paraphrase can invert what is in or out of scope.

## Template

```markdown
## 1. TASK

**Your Assignment**: Slice <#>: <title>
**Overall Goal**: <the success check from phase 1, one sentence>

<what to produce and which existing pattern to apply, two or three sentences>

## 2. EXPECTED OUTCOME

**Files to Modify**: <the slice's Files>
**Done when**: <a checkable condition; a command and its expected result where one exists>
**QA**: <a command or scenario, or "None; Done when is the check">
**Capture evidence to**: none; paste the command output into your Verification block

## 3. REQUIRED TOOLS

Standard toolset; no additional tools required.

## 4. MUST DO

- There is no plan file. Everything you need is in this briefing; if something is missing, stop and report `[BRIEFING GAP]` with the missing block.
- Follow the project instructions (AGENTS.md and the project's CLAUDE.md files, already in your context).
- <test directive, one of: "Write the failing test first, confirm it fails for the right reason, then implement" (a bug fix, or when the project instructions ask for TDD) | "Write a test for the behaviour after you implement it" (new behaviour in a surface that has a test suite) | omit when the slice has no testable behaviour>
- Stop on an internal contradiction: if Description, Done when or QA cannot be met without breaking a Must NOT or a guardrail below, stop and report `[CONTRADICTION]` under Issues.
- Report each within-spec deviation under Deviations in the four-field format.
- After implementing, verify only what you touched: format check, lint and the CLI analyzer on your Files, and the tests of those files, in parallel. Never the full suite or a repo-wide lint; the orchestrator runs those. Treat a `<diagnostics>` block as a hint and confirm it with the CLI analyzer before you fix or dismiss it (`verification.md`, the path is in Runtime Commands). Report the results in your Output Format.

## 5. MUST NOT DO

- Do not modify files outside the Files list.
- Do not add features beyond the Description.
- Do not skip or modify tests to make them pass.
- Do not add dependencies.
- <slice-specific exclusions, from the interview or the research>

## 6. CONTEXT

### Runtime Commands
<the touched-file format, lint, analyzer and related-test commands from the project instructions or the manifests>
<the absolute path of `../execute/references/verification.md`, resolved from this skill's base directory, on its own line: the worker has no skill directory of its own>

### Wisdom from earlier waves
<what earlier workers or the research found that this slice should follow; omit the section when there is none>

### Dependencies
<the slices this one builds on and one line on what each produced; omit when none>

### Depth and negative results
Read the Files list and the references in full before changing anything. "I looked at X and Y and the pattern is not there" is a usable result and belongs under Issues; silence on a question this briefing asked is not.

### Pattern references
<each as `file_path:line_number` plus one line on what to follow there; an entry is an instruction to reuse the existing thing, not a hint>

### Codebase conventions
<naming, error handling, comment density, path aliases, test layout, as found in the project instructions, the research and the files; verbatim, not summarised>

### Invariants to preserve
<the success check in one line, plus any behaviour this slice could break>

### Guardrails
- No scope inflation: changes touch only the listed files.
- No premature abstraction: a utility extraction needs three concrete callers.
- No copy-paste with slight variation.
- Comments only where the why is non-obvious; no decorative docstrings.
- No documentation bloat: no unrequested READMEs, no inline narration.
- No validation of trusted internal inputs.
- No backwards-compatibility shims unless the slice says so.
- Framework completeness: when the slice declares a controller, model, resource or component the framework expects in a known shape, the Files and Description cover every part the framework will invoke at runtime.
```

## Tier choice

| Tier | Pick when |
|---|---|
| `quick` | One file, mechanical, the edit is fully stated |
| `junior` | The default: one to three files, an existing pattern to apply |
| `junior-high` | Junior-shaped, but coupling or context depth sits at the border |
| `senior` | Cross-layer change, a migration, or edge cases that need design |

Pick the lowest tier whose scope fits the slice. A worker that reports a tier mismatch under Issues is a reason to go one tier up on the retry, not to widen the brief.
