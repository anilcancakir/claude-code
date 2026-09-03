---
type: tool_used
tool: Agent
input_match: '"subagent_type"\s*:\s*"ac:librarian"'
min: 1
max: 1
weight: 1
---

The orchestrator delegates to `ac:librarian` exactly once. Without this grader the case scores on
the orchestrator's own web access, which is not the behaviour under test.
