---
name: explore-citation-accuracy
tags: [explore, accuracy]
runs: 3
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Agent, Bash]
---

A small TypeScript project sits in your working directory under `src/`.

Delegate this question to the `ac:explore` subagent rather than answering it from your own read:

> Where is the function `resolveProfile` defined? List every definition site.

Brief the subagent with `DEPTH: quick` and `BUDGET: one pass`, and tell it that completeness matters:
a definition site it omits is a failure, and a file that only mentions the name without defining it
is not a definition site.

When the subagent returns, reproduce its Findings section verbatim in your final message, keeping
each citation exactly as it wrote it. Add nothing else.
