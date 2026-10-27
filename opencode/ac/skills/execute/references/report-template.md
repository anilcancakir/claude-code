<!-- ported-from: plugins/ac/skills/execute/references/report-template.md sha256:74289d0c4c633f7c51dda3131028158dd9c8ea45e543eae0e529067664dde2fd -->
# Execution Report Template

Markdown structure for `.ac/plans/<slug>/report.md`. Written at Phase 4b after all waves verify and the final code-review settles. This is the long-form artifact for the user; the inline execution summary (Phase 4b) is the short-form heartbeat.

## When to read this

Read in Phase 4b before calling `write` on `.ac/plans/<slug>/report.md`. After the write, verify the file landed: `shell: test -f .ac/plans/<slug>/report.md && wc -l .ac/plans/<slug>/report.md`. If absent or zero-length, retry the write once; if still failing, render the report inline to the user.

## Template

```markdown
# Execution Report: <plan title>

**Plan**: .ac/plans/<slug>/plan.md
**Generated**: <ISO timestamp>

## Summary
<1-2 sentences: what the plan delivered, overall posture>.

## Steps Executed

| # | Step | Tier | Result | Files |
|---|------|------|--------|-------|
| 1 | <title> | <tier> | PASS | <file, ...> |
| 2 | <title> | <tier> | escalated to <new tier>, PASS | <file, ...> |
| 3 | <title> | senior | FAIL (3-strike accepted) | <file, ...> |

**Steps**: <N>/<total> passed | **Escalations**: <N> | **Failed steps**: <N>

## Modified Files

- <file_path:line_number>: <one-line what changed>

## Verification

- Final typecheck: PASS | FAIL
- Final build: PASS | FAIL
- Final tests: <N pass, N fail>
- Final lint: PASS | FAIL
- Code-review: <N CRITICAL fixed, N IMPORTANT deferred, or `no findings`>
- Oracle: <bottom line> | SKIPPED (planner judged nothing critical) | SKIPPED (path-only criticality, routed to the reviewer) | SKIPPED (--no-oracle)
- QA: <status from the QA result block, cases run/passed/failed/blocked, findings by severity; report at .ac/plans/<slug>/qa/<run id>/report.md> | could-not-run (<reason>) | SKIPPED (plan QA is false) | SKIPPED (--no-qa)

## Wisdom Accumulated

<contents of .ac/plans/<slug>/wisdom.md, dropped here for posterity>

## Notes

<non-obvious decisions made during execution, root causes hit, provider fallbacks taken (step, from model, to model), anything the next person should know>

## Commits

<git log --oneline since the plan started, produced by the final commit skill run>
```
