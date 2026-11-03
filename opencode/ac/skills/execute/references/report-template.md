<!-- ported-from: plugins/ac/skills/execute/references/report-template.md sha256:36242960b3689c0064a22ce70358864ca38f81c5466d2e28bb171dbb69432272 -->
# Execution Report Template

Markdown structure for `.ac/plans/<slug>/report.md` (`outcome.md` under `LANE_MODE`, one archive layout with the Claude Code side). Written at Phase 4b after all waves verify and the final code-review settles. This is the long-form artifact for the user; the inline execution summary (Phase 4b) is the short-form heartbeat.

It carries only what no other file holds. The plan checkboxes already record which steps ran, git records the modified files and the commits, and `wisdom.md` holds the wisdom, so the report names none of them again.

## When to read this

Read in Phase 4b before calling `write` on the report path (`.ac/plans/<slug>/report.md`, or `outcome.md` under `LANE_MODE`). After the write, verify the file landed: `shell: test -f <report path> && wc -l <report path>`. If absent or zero-length, retry the write once; if still failing, render the report inline to the user.

## Template

```markdown
# Execution Report: <plan title>

**Plan**: .ac/plans/<slug>/plan.md
**Generated**: <ISO timestamp>

## Summary
<1-2 sentences: what the plan delivered, overall posture. Name failed steps (accepted via 3-strike), skipped dependent
steps and tier escalations here when there were any.>

## Verification

- Final typecheck: PASS | FAIL
- Final build: PASS | FAIL
- Final tests: <N pass, N fail>
- Final lint: PASS | FAIL
- Code-review: <N CRITICAL fixed, N IMPORTANT deferred, or `no findings`>
- Oracle: <bottom line> | SKIPPED (planner judged nothing critical) | SKIPPED (path-only criticality, routed to the reviewer) | SKIPPED (--no-oracle)
- QA: <status from the QA result block, cases run/passed/failed/blocked, findings by severity; report at .ac/plans/<slug>/qa/<run id>/report.md> | could-not-run (<reason>) | SKIPPED (plan QA is false) | SKIPPED (--no-qa)

## Deferred

<IMPORTANT findings recorded rather than fixed, MINOR or low-confidence findings (3c), unfixed QA findings, anything
added to the plan's `## Deferred Ideas`. `None` when empty.>

## Notes

<non-obvious decisions made during execution, root causes hit, provider fallbacks taken (step, from model, to model),
the quick-to-junior routing count (1c), a missing TDD field (1f), a skipped final commit (4a F7) with the path and the
count, anything the next person should know>
```
