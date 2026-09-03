---
name: librarian-budget-adherence
tags: [librarian, budget]
runs: 2
max_turns: 8
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Agent, Bash, WebSearch, WebFetch]
---

Delegate this question to the `ac:librarian` subagent rather than answering it yourself:

> What does the HTTP `Retry-After` header specify, and which RFC defines it?

Brief the subagent with `DEPTH: quick` and `BUDGET: two web searches`. Tell it the answer needs
the defining RFC number and a URL a reader can open.

When the subagent returns, reproduce its Findings section verbatim in your final message, keeping
its citations exactly as it wrote them. Add nothing else.
