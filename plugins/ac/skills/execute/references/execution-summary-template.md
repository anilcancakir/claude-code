# Execution Summary Render Template

The plain-text summary rendered to the user at Phase 4c after the final commit and dev-report write. This is the closing heartbeat that confirms the plan delivered.

## When to read this

Read in Phase 4c after Phase 4a (final commit) and Phase 4b (dev report) complete. Render inline to the user; do not write to a file (the report.md at Phase 4b is the file artifact).

## Template

```
## Execution Complete

Plan: <title> (.ac/plans/<slug>/plan.md)
Complexity: <complexity> | Steps: <N>/<total> | Escalations: <N>

Verification:
- Code-review: APPROVED (<standard|deep>)
- Oracle: APPROVED | SKIPPED (--no-oracle) | <verdict if accepted with findings>

Artifacts:
- Plan: .ac/plans/<slug>/plan.md
- Wisdom: .ac/plans/<slug>/wisdom.md
- Evidence: .ac/plans/<slug>/evidence/ (<N> files)
- Report: .ac/plans/<slug>/report.md
- Commits: <hash list, from /ac:commit output>

<If any failed steps:>
Failed steps (accepted via 3-strike):
- Step <N>: <title> — <one-line reason>

Plan complete.
```

After rendering, TaskUpdate Phase 4 to `completed` and end the turn.
