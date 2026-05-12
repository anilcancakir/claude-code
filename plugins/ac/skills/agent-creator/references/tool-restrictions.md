# Tool Restrictions

Choosing the right tool access for a custom subagent. Read this when designing `tools` or `disallowedTools` for a new agent, when restricting which subagent types a coordinator can spawn, or when adding conditional Bash validation via hooks.

Source of truth: `tools/AgentTool/loadAgentsDir.ts` and `tools/AgentTool/prompt.ts` in the CC source.

## Contents

- The three patterns: allowlist, denylist, hybrid
- The `Agent(x, y)` spawn restriction
- Available tool names
- MCP tool restrictions
- Conditional Bash with PreToolUse hooks
- Permission mode interaction
- Inheritance from the parent
- Anti-patterns

## The three patterns

### Allowlist (recommended for focused agents)

```yaml
tools: Read, Grep, Glob, Bash
```

The agent can only use the listed tools. Anything not in the list is unavailable. Default choice for read-only research, classification, audit agents.

Implementation: per `tools/AgentTool/loadAgentsDir.ts`, an allowlist of `['*']` means "inherit all"; otherwise the agent's available tools is exactly the listed set.

### Denylist (start broad, subtract)

```yaml
disallowedTools: Write, Edit, NotebookEdit
```

Inherits every tool the parent has, then removes the listed ones. Useful when "everything except writes" reads more clearly than enumerating the read-only set.

### Hybrid (rare)

```yaml
tools: Read, Grep, Bash, Edit
disallowedTools: Bash(rm:*)
```

Both fields set. `disallowedTools` applies first to the inherited pool; then `tools` filters the remaining pool. A tool listed in both is removed.

Pick based on what reads cleanest. For most agents, one or the other suffices.

## The `Agent(x, y)` spawn restriction

The Agent tool is itself a tool, so listing or omitting it in `tools` controls subagent spawning. This matters only for agents that run as the main thread via `claude --agent <name>`; subagents themselves cannot spawn other subagents (the Agent tool is unavailable in subagent contexts).

| Frontmatter | Behavior |
|-------------|----------|
| `tools: Agent, Read, Bash` | Can spawn any agent type, plus Read and Bash. |
| `tools: Agent(worker, researcher), Read, Bash` | Can spawn ONLY `worker` and `researcher`, plus Read and Bash. |
| `tools: Read, Bash` (no `Agent` entry) | Cannot spawn any subagent. |

The parenthesized form is an allowlist. The orchestrator's prompt strips other agent types from its listing when this restriction is active, so the model does not even see them as options.

For denying specific agents while allowing all others, use `permissions.deny` in `settings.json`:

```json
{
  "permissions": {
    "deny": ["Agent(Explore)", "Agent(deploy-bot)"]
  }
}
```

## Available tool names

Core tools the orchestrator and subagents have:

| Tool | Description |
|------|-------------|
| `Read` | Read a file |
| `Write` | Write or overwrite a file |
| `Edit` | String-replace in a file |
| `Glob` | File pattern match |
| `Grep` | Regex search across files |
| `Bash` | Run a shell command |
| `BashOutput` | Read output of a backgrounded Bash process |
| `KillShell` | Kill a backgrounded Bash process |
| `Agent` | Spawn a subagent (main-thread only) |
| `AskUserQuestion` | Surface an interactive prompt |
| `WebFetch` | Fetch a URL |
| `WebSearch` | Search the web |
| `NotebookEdit` | Edit a Jupyter notebook cell |
| `ExitPlanMode` | Exit plan mode with a plan |
| `Skill` | Invoke a skill (when applicable) |
| `LSP` | Language-server operations (workspaceSymbol, findReferences, hover, etc.) |
| `Monitor` | Stream events from a background process |

Plus MCP tools, which follow `mcp__<server>__<tool>` naming.

Bash subcommand patterns work in `tools` too:

```yaml
tools: Read, Grep, Bash(git:*), Bash(gh pr view:*)
```

`Bash(git:*)` allows any `git` subcommand; `Bash(gh pr view:*)` allows only `gh pr view` with any args. Narrower is safer.

## MCP tool restrictions

Each MCP tool is named `mcp__<server>__<tool>`. To allow only specific MCP tools:

```yaml
tools: Read, Grep, mcp__playwright__navigate, mcp__playwright__screenshot
```

To allow an entire MCP server's tools:

```yaml
tools: Read, Grep, mcp__playwright__*
```

(Glob-style wildcard. Check current CC behavior; pattern support may vary.)

For per-agent MCP server scoping (non-plugin agents only), use the `mcpServers` frontmatter:

```yaml
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
```

The agent gets the MCP server connection at spawn and loses it at finish. The parent conversation never sees the server's tools, keeping its tool listing clean.

## Conditional Bash with PreToolUse hooks

When `tools: Bash` is too permissive but enumerating safe subcommands does not cover the cases you want (e.g., "any SELECT query but no INSERT"), use a `PreToolUse` hook for runtime validation.

```yaml
---
name: db-reader
description: Execute read-only database queries. Use when analyzing data or generating reports.
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---
```

The hook script reads CC's hook input as JSON on stdin, decides allow/deny, and exits with code 2 to block (with a message on stderr):

```bash
#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if echo "$COMMAND" | grep -iE '\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b' > /dev/null; then
  echo "Blocked: read-only mode" >&2
  exit 2
fi
exit 0
```

Plugin agents IGNORE `hooks` (security boundary). If you need conditional validation in a plugin agent, the user has to either install the hook themselves or use a narrower `tools:` field.

## Permission mode interaction

Tool restrictions are independent of `permissionMode`. The flow:

1. The agent attempts a tool call.
2. Tool-restriction check (`tools`/`disallowedTools`). Fails fast if not allowed.
3. Permission check (`permissionMode` + project permissions + hooks). Fails or prompts based on mode.

`permissionMode: bypassPermissions` does NOT override `tools` restrictions. An agent with `tools: Read, Grep` cannot use Write even under `bypassPermissions`. The two systems compose.

Non-plugin only: `permissionMode` field. Plugin agents always run under the parent's mode.

## Inheritance from the parent

Per the Anthropic docs and `loadAgentsDir.ts`:

- Subagents inherit the parent's permission context (allow/deny rules) as the baseline.
- Subagents do NOT inherit the parent's tool selection automatically; they get the full Claude Code tool set minus the agent's own restrictions.
- Subagents do NOT inherit skills from the parent; use `skills:` to preload.
- Subagents inherit the parent's working directory (`cd` does not persist between Bash calls within the subagent).
- If `isolation: worktree` is set, the subagent runs in an isolated temporary worktree instead of the parent's working directory.

For plugin agents, the parent's permission context still applies, but `permissionMode` set in the plugin agent's frontmatter is ignored.

## Anti-patterns

| Anti-pattern | Symptom | Fix |
|---|---|---|
| Empty `tools: []` | Agent has no tools, returns nothing | Either omit the field (inherit all) or list the tools the body uses |
| `tools: Bash` (bare, broad) | Agent can run any shell command, defeats permission system | List narrow Bash subcommands or use `PreToolUse` hook to validate |
| `tools: *` (unsupported) | Loader may treat as literal "*" or fall back; unclear semantics | Either omit `tools` (inherit all) or enumerate |
| `tools` listed but body uses unlisted tool | Tool call fails fast at runtime | Read the body, list every tool the steps actually use |
| `disallowedTools: Write` but body says "edit the file" | Body and frontmatter contradict; agent confused | Pick one: either allow Edit/Write (and update frontmatter), or change body to "report what should change" |
| `Agent` in subagent's `tools` | Has no effect (subagents cannot spawn) | Remove it; it is meaningful only for main-thread agents |
| `mcpServers` in plugin agent | Silently ignored | Move agent to `.claude/agents/`, or accept that MCP servers must come via the user's session config |
| `hooks` in plugin agent | Silently ignored | Same as above |
| `permissionMode: bypassPermissions` but `tools: Read` | `bypassPermissions` does not unlock unlisted tools | Both layers compose. Adjust whichever layer is wrong. |
| Conditional Bash without a `PreToolUse` hook | Bash is allowed unconditionally, dangerous calls slip through | Add the hook script, exit 2 to block writes |
