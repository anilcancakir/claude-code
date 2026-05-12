---
name: <kebab-case-name>
description: <Third-person summary of what the agent does AND when the orchestrator should delegate to it. Front-load the verb and noun. Include trigger phrases. Add "use proactively" if you want aggressive delegation.>
# Add only the fields the agent actually needs:
# tools: Read, Grep, Glob                    # allowlist; omit to inherit every tool
# disallowedTools: Write, Edit, NotebookEdit # denylist; applied first when both are set
# model: sonnet                              # sonnet | opus | haiku | <full-model-id> | inherit (default)
# effort: medium                             # low | medium | high | xhigh | max
# permissionMode: acceptEdits                # NON-PLUGIN only; default | acceptEdits | auto | dontAsk | bypassPermissions | plan
# maxTurns: 20                               # cap the agentic turn count
# skills:                                    # full skill bodies injected into system prompt at startup
#   - api-conventions
#   - error-handling-patterns
# mcpServers:                                # NON-PLUGIN only; inline definitions or named references
#   - playwright:
#       type: stdio
#       command: npx
#       args: ["-y", "@playwright/mcp@latest"]
# hooks:                                     # NON-PLUGIN only; same shape as project hooks
#   PreToolUse:
#     - matcher: "Bash"
#       hooks:
#         - type: command
#           command: "./scripts/validate.sh"
# memory: project                            # user | project | local; auto-injects Read/Write/Edit
# background: true                           # default to background execution
# isolation: worktree                        # spawn in a temporary git worktree
# color: green                               # red | blue | green | yellow | purple | orange | pink | cyan
# initialPrompt: "..."                       # main-agent mode only (--agent flag)
---

## Identity

<One or two sentences: who the agent is, what it returns. Anchors the lens.>

## Execution

<Numbered steps the agent follows. Reads first, then acts, then verifies. Sub-numbers (3a, 3b) for steps that run in parallel.>

1. <Step 1: read first>
2. <Step 2: act precisely>
3. <Step 3: verify>

## Output Format

<Exact markdown shape the agent returns. Locked headers, citation format, length cap.>

```
<verbatim section header>
<content shape with citations>

<verbatim section header>
<content shape>
```

<Length cap, e.g., "Under 800 words.">

## Failure Conditions

FAILED if:
- <quality-gate violation 1>
- <quality-gate violation 2>
- <quality-gate violation 3>

## Constraints

- <hard rule 1>
- <hard rule 2>
- <hard rule 3>

<!--
Skip the five-section pattern only when the agent is genuinely trivial (one-step, no parseable output). Most focused agents earn each section.

When designing the body:
- Identity in second person ("You are X. You do Y.").
- Execution in imperative voice ("Read the file" not "you should read the file").
- Output Format locked verbatim so the orchestrator can parse the result.
- Failure Conditions list observable gates the agent self-checks against.
- Constraints are hard rules, not soft preferences.

Plugin agents only:
- ${CLAUDE_PLUGIN_ROOT} substitutes to the plugin root in the body.
- ${user_config.X} substitutes to per-plugin user-config values (sensitive keys masked).
- permissionMode, hooks, mcpServers are silently ignored (security boundary).

Non-plugin agents:
- No substitution at all; tokens stay literal.

Subagents in any scope:
- Cannot spawn other subagents (the Agent tool is unavailable).
- Inherit CLAUDE.md by default.
- Do NOT inherit skills from the parent; list them in `skills:` explicitly.
- Inherit the parent's working directory; cd does not persist between Bash calls within the subagent.
-->
