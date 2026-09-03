---
type: tool_used
tool: WebSearch
min: 0
max: 2
weight: 1
---

The `BUDGET: two web searches` in the brief binds. This is the property the agent body claims at
`plugins/ac/agents/librarian.md:47`, and the number is what makes it checkable.

`min: 0` is deliberate: answering from a direct fetch without searching at all is a better outcome,
not a worse one. Only overshooting the stated ceiling is the failure.

The baseline this replaces was measured by hand over 414 historical runs at a mean of 13.32
searches, so a regression here is visible rather than a matter of impression.
