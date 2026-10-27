# Execution Summary Render Template

The plain-text summary rendered to the user at Phase 4b after the final commit and dev-report write. This is the closing heartbeat that confirms the plan delivered.

## When to read this

Read in Phase 4b after the final commit and the dev report are written. Render inline to the user; do not write to a file (the report.md at Phase 4b is the file artifact).

## Template

```
## Execution Complete

Plan: <title> (.ac/plans/<slug>/plan.md)
Steps: <N>/<total> | Escalations: <N>

Verification:
- Code-review: <N CRITICAL fixed, N IMPORTANT deferred, or `no findings`>
- Oracle: <bottom line> | SKIPPED (planner judged nothing critical) | SKIPPED (path-only criticality, routed to the reviewer) | SKIPPED (--no-oracle) | <verdict if accepted with findings>
- QA: <status, cases passed/run, findings by severity> | could-not-run (<reason>) | SKIPPED (plan QA is false) | SKIPPED (--no-qa)

Artifacts:
- Plan: .ac/plans/<slug>/plan.md
- Wisdom: .ac/plans/<slug>/wisdom.md
- Evidence: .ac/plans/<slug>/evidence/ (<N> files)
- QA: .ac/plans/<slug>/qa/<run id>/report.md (only when the QA pass ran)
- Report: .ac/plans/<slug>/report.md
- Commits: <hash list, from /ac:commit output>

<If any failed steps:>
Failed steps (accepted via 3-strike):
- Step <N>: <title>: <one-line reason>

Plan complete.
```

After rendering, end the turn.
