---
type: regex
pattern: 'admin-service\.ts:4'
target: trace
match: contains
weight: 1
---

The second definition site is cited with its line. This is the completeness half: the same
function name lives in two modules, and a search that stops at the first hit fails here while
still passing every other grader in this case.
