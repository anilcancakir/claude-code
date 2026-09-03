---
type: regex
pattern: 'profile-helpers'
target: last_message
match: not_contains
weight: 1
---

The decoy is not reported as a definition site. `src/legacy/profile-helpers.js` names the function
in a comment and defines something else, so a text search that does not separate a mention from a
definition cites it.

Matched against `last_message` rather than `trace` on purpose: the subagent is expected to open the
decoy while searching, and reading it is correct. Only carrying it into the answer is the failure.
