---
type: regex
pattern: 'user-service\.ts:7'
target: trace
match: contains
weight: 1
---

The first definition site is cited with its line. Matched against `trace` rather than
`last_message` because the trace carries the subagent's own turns, tagged with `subagent_type`,
so the citation is graded where it was written rather than after the orchestrator relays it.

The pattern is the basename and line only: the sandbox workspace path is generated per run, so
anchoring on an absolute path would never match.
