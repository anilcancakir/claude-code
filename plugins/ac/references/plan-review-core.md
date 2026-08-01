# Plan review core checks

Both plan-review agents, the standard reviewer and its adversarial counterpart, read this file in full, and both run every check below unconditionally.

### Check 1: Reference Validity

For every `file_path:line_number` reference in the plan (Research Summary, Codebase Conventions source list, Reuse Map, Steps' References field):

- Open the file with `Read`. Confirm the file exists at the cited path.
- For line-anchored references, confirm the line range is sensible (the file is long enough to contain the cited line, and a small window around the line looks topically related to the plan's claim).
- For "follow pattern in X" claims, read X and confirm the pattern is actually there.
- Use `LSP` (`hover`, `goToDefinition`) to confirm a named symbol exists at the cited location when a symbol is named.

Pass when the reference exists and is reasonably relevant. Fail only when the file is missing, or the cited content has no plausible connection to the plan's claim.

### Check 2: Executability

For every step in `## Steps`:

- Can a developer with this plan in hand start working on the step? A concrete starting point is enough: a file path, a pattern reference, or a description specific enough that the next action is obvious.
- Verify the step has the required fields: `Type`, `Tier`, `Why this tier`, `Files`, `Description`, `Done when`. References and QA may be present or absent depending on plan stage; their absence is not a blocker.

Pass when there is a concrete starting point. Fail only when a step is so vague that a fresh developer has no idea where to begin (for example, `Description: "Implement the feature."` with no files, no references, no acceptance criterion).

### Check 3: Internal Consistency

Scan the plan for contradictions that would block execution:

- A step references a file or symbol that another step has not yet created (forward dependency violated by wave ordering).
- Two steps in the same wave declare overlapping `Files` (file-exclusive parallelism violated).
- The plan's `Must NOT Have` guardrails contradict something a step prescribes.
- The `Codebase Conventions` section claims one style; a step prescribes the opposite.
- A locked decision in research/synthesis is contradicted by a step.

Pass when the plan reads as internally coherent. Fail only on contradictions that would block execution; minor stylistic inconsistency between sections is not a blocker.

### Check 4: Tier Fitness

For every step, check whether the assigned tier matches the work's actual shape. The shapes: `quick` is single-file mechanical work, `junior` is 1 to 3 files of standard implementation, `junior-high` is junior-shaped work at the borderline of coupling or context depth, `senior` is cross-layer or architectural work across several coupled files.

- A `quick` step that requires reading 3+ files or applying a non-trivial pattern is mis-tiered (should be `junior`). The write-style giveaway: the step's Description goes beyond "what to produce" into multi-step prescription.
- A `senior` step that touches one file with one concern is mis-tiered (should be `junior`). The write-style giveaway: the step is a single concrete action wrapped in architectural-sounding prose.
- The plan's `Why this tier` field for each step makes a defensible claim that matches the step's Description.

Pass when each step's tier is defensible from its Description and Files. Fail only on tier mismatches that would actually mis-route execution (for example, a 4-file cross-layer step assigned `quick`).
