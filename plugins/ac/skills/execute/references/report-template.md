# Execution Report Template

Markdown structure for `.ac/plans/<slug>/report.md`. Written at Phase 4b after all waves verify and the final code-review settles. This is the long-form artifact for the user; the inline execution summary (Phase 4c) is the short-form heartbeat.

## When to read this

Read in Phase 4b before calling `Write` on `.ac/plans/<slug>/report.md`. After Write, verify the file landed: `Bash test -f .ac/plans/<slug>/report.md && wc -l .ac/plans/<slug>/report.md`. If absent or zero-length, retry Write once; if still failing, render the report inline to the user.

## Template

```markdown
# Execution Report: <plan title>

**Plan**: .ac/plans/<slug>/plan.md
**Complexity**: <simple | standard | complex>
**Generated**: <ISO timestamp>

## Summary
<1-2 sentences: what the plan delivered, overall posture>.

## Steps Executed

| # | Step | Tier | Result | Files |
|---|------|------|--------|-------|
| 1 | <title> | <tier> | PASS | <file, ...> |
| 2 | <title> | <tier> | escalated → <new tier> PASS | <file, ...> |
| 3 | <title> | senior | FAIL (3-strike accepted) | <file, ...> |

**Steps**: <N>/<total> passed | **Escalations**: <N> | **Failed steps**: <N>

## Modified Files

- <file_path:line_number> — <one-line what changed>

## Verification

- Final build: PASS | FAIL
- Final tests: <N pass, N fail>
- Final lint: PASS | FAIL
- Code-review: APPROVED (<standard|deep>)
- Oracle: APPROVED | SKIPPED | <bottom-line if BLOCKED accepted>

## Wisdom Accumulated

<contents of .ac/plans/<slug>/wisdom.md, dropped here for posterity>

## Notes

<non-obvious decisions made during execution, root causes hit, anything the next person should know>

## Commits

<git log --oneline since the plan started — produced by the final /ac:commit>
```
