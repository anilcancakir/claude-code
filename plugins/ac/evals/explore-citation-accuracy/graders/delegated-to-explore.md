---
type: tool_used
tool: Agent
input_match: '"subagent_type"\s*:\s*"ac:explore"'
min: 1
max: 1
weight: 1
---

The orchestrator delegates to `ac:explore` exactly once. Without this grader a run can score full
marks on the orchestrator's own read, which measures the wrong model.
