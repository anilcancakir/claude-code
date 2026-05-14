# Checkpoint Schema

JSON shape and write points for `.ac/plans/<slug>/checkpoint.json`. The checkpoint is the auto-compact safety net: every load-bearing decision and synthesis the planner builds is persisted so the next `/ac:plan` invocation can resume from where the previous one stopped.

## When to read this

Read whenever a stage writes a checkpoint. Write points are listed at the bottom; the JSON shape is the canonical form.

## Schema

`.ac/plans/<slug>/checkpoint.json`:

```json
{
  "slug": "<slug>",
  "last_stage": "0 | 1 | 2 | 3 | 3-complete | 5-complete",
  "topic": "<original topic string>",
  "codebase_state": "disciplined | transitional | legacy | chaotic | greenfield | null",
  "conventions": {
    "naming": "...",
    "error_handling": "...",
    "comment_density": "...",
    "type_discipline": "...",
    "file_organization": "...",
    "import_convention": "..."
  },
  "reuse_map": [
    { "ref": "src/path:line", "provides": "...", "used_by_decision": "..." }
  ],
  "locked_requirements": [
    { "current": "...", "target": "...", "acceptance": "..." }
  ],
  "locked_decisions": [
    { "decision": "...", "choice": "...", "rationale": "..." }
  ],
  "canonical_refs": [
    { "path": "src/path:line", "what_it_provides": "..." }
  ],
  "deferred_ideas": [
    "<idea>: <reason deferred>"
  ],
  "risks_accepted": [
    "<decision and recommended default>: <reason>"
  ]
}
```

## Write points

The checkpoint is written at these stage transitions; later writes overwrite earlier ones (the file is small enough that full rewrite is correct).

- After Stage 1d (research complete) → `last_stage: "1"`.
- After Stage 2d (synthesis) → `last_stage: "2"`.
- After each Stage 3 node is resolved → `last_stage: "3"` with the latest locked decision appended.
- Stage 3 complete → `last_stage: "3-complete"`.
- Optionally after Stage 5 (before deletion) → `last_stage: "5-complete"`.

The checkpoint is deleted in Stage 6 once the plan is locked, reviewed, and delivered.

## Resume contract

On `/ac:plan` invocation, if `CHECKPOINT_PATH` exists:

- When `AUTO_MODE = false`: ask the user via `AskUserQuestion` (`Resume?` / `Start fresh`). Default: Resume.
- When `AUTO_MODE = true`: auto-pick Resume.

On Resume: restore working memory from the JSON (locked_decisions, locked_requirements, canonical_refs, deferred_ideas, codebase_state, conventions, reuse_map, last_stage) and jump to the stage indicated by `last_stage`. On Start fresh: delete the checkpoint and re-enter Stage 0f.
