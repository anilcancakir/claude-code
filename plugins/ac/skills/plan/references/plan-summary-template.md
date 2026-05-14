# Plan Summary Render Template

The plain-text summary the planner renders at Stage 6 (Deliver) after the plan is locked and reviewed. This is the user-facing closing artifact of `/ac:plan`; it does not replace the plan file, it points at it.

## When to read this

Read in Stage 6 after deleting `CHECKPOINT_PATH`. Render the summary inline to the user with concrete values from the plan file. When `AUTO_MODE = true`, render this summary AND chain into `/ac:execute --auto <slug>` (see SKILL.md Stage 6a).

## Template

```
## Plan Generated: <title>

**Path**: .ac/plans/<slug>/plan.md
**Complexity**: <simple | standard | complex>
**Steps**: <N> | **Waves**: <N>
**Tiers**: <N quick / N junior / N senior>
**Codebase State**: <classification>

### Key Decisions
- <Decision>: <Brief rationale>

### Scope
- IN: <what is included>
- OUT: <what is excluded>

### Reuse Map
- <N existing utilities and patterns to leverage>; full map in plan.md

### Review Verdict (Stage 5.5)
- Tier: <standard | complex | skipped>
- Iterations: <N, or "N/A" if skipped>
- Final verdict: <OKAY | proceed-with-noted-issues | skipped (simple plan) | skipped by user request>
- Issues addressed: <count, or "None">
- Issues noted in Risks Accepted: <count, or "None">

### Cross-Project Observations (omit when zero)
- <N findings flagged for sibling-fix follow-up; full list in plan.md `## Cross-Project Observations`>

### Artifacts
- Plan: .ac/plans/<slug>/plan.md
- Interview log: .ac/plans/<slug>/interview-log.md (<N> rounds, <M> Q&A pairs)
- Research: .ac/plans/<slug>/research/ (<N> files)

### Next Step
Run `/ac:execute <slug>` to execute the plan. For complex plans, the deep code-review runs in parallel with `ac:oracle` by default; opt out with `/ac:execute <slug> --no-oracle`. For complex plans where wave-after checkpoint commits are unwanted, use `--no-checkpoint-commits`.
```
