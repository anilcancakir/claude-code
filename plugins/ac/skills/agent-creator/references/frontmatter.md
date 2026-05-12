# Frontmatter Reference

Every field a Claude Code agent recognizes, what it does, when to set it, and valid values. Read this when designing or auditing the YAML block at the top of an agent file. Source of truth: `tools/AgentTool/loadAgentsDir.ts` and `utils/plugins/loadPluginAgents.ts` in the CC source; live Anthropic docs at [sub-agents.md](https://docs.claude.com/en/docs/claude-code/sub-agents.md).

## Contents

- Required fields
- Tool restriction fields
- Model and effort
- Permission and isolation
- Memory and skills
- Lifecycle and presentation
- Composite examples
- Plugin-agent restrictions
- Parsing pitfalls

## Required fields

### `name`

Unique identifier the orchestrator uses to delegate. Lowercase letters and hyphens. Max 64 characters. Plugin agents auto-namespace as `<plugin>:<name>` (and the underlying filename can be shorter).

```yaml
name: code-reviewer
```

### `description`

What the agent does AND when the orchestrator should delegate to it. This is the trigger surface, the single line the orchestrator reads when deciding whether to call this agent. Format guidance:

- Third person ("Reviews code for security issues"), not first or second person.
- Front-load the verb and noun, then the contexts that pull it in.
- Add "use proactively" when you want aggressive delegation.
- Include trigger phrases the user might say ("review this", "audit", "check my PR").
- Cover concrete contexts where this agent should fire.

```yaml
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
```

The loader also accepts `when-to-use` as a synonym for `description` in plugin agents (per `loadPluginAgents.ts:93-96`). Prefer `description`.

## Tool restriction fields

### `tools`

Allowlist of tools the agent can use. Comma-separated string OR YAML array. Omitting `tools` means the agent inherits every tool available to the parent (including MCP tools).

```yaml
tools: Read, Grep, Glob, Bash
# or
tools:
  - Read
  - Grep
  - Glob
  - Bash
```

Special form for restricting Agent-tool spawning (only meaningful for agents that run as the main thread via `claude --agent <name>`):

```yaml
tools: Agent(worker, researcher), Read, Bash
```

`Agent(x, y)` is an allowlist of subagent types this agent can spawn. `Agent` without parens allows any. Omitting `Agent` blocks all spawning.

### `disallowedTools`

Denylist of tools to remove from the inherited pool. Applied first; if `tools` is also set, the disallow filters the inherited pool and then `tools` filters that result.

```yaml
disallowedTools: Write, Edit, NotebookEdit
```

Use the denylist when "inherit everything except a few" reads more clearly than enumerating an allowlist.

## Model and effort

### `model`

Which model the agent runs on. Default: `inherit` (same as the parent session).

```yaml
model: sonnet           # alias
model: opus
model: haiku
model: claude-opus-4-7  # full ID
model: inherit
```

Resolution order at spawn time:

1. `CLAUDE_CODE_SUBAGENT_MODEL` env var (if set).
2. Per-invocation `model` parameter the orchestrator passes.
3. The agent's frontmatter `model`.
4. The main conversation's model.

### `effort`

Reasoning budget override (`low`/`medium`/`high`/`xhigh`/`max`). Defaults to inheriting the session effort.

```yaml
effort: high
```

Set explicitly only when the agent needs a different budget than the parent. Most agents inherit fine.

## Permission and isolation

### `permissionMode`

Non-plugin agents only. Controls how the agent handles permission prompts.

| Mode | Behavior |
|------|----------|
| `default` | Standard prompts |
| `acceptEdits` | Auto-accept file edits in working dirs |
| `auto` | Background classifier reviews each command |
| `dontAsk` | Auto-deny new prompts; only pre-approved tools work |
| `bypassPermissions` | Skip prompts; CC still protects `.git`, `.claude`, `.vscode`, `.idea`, `.husky` |
| `plan` | Read-only exploration |

Parent precedence: if the parent runs `bypassPermissions` or `acceptEdits`, that overrides the agent's setting. If the parent runs `auto`, the agent's mode is ignored entirely.

Plugin agents IGNORE this field (with a warning log).

### `isolation`

Run the agent in an isolated environment.

```yaml
isolation: worktree
```

`worktree` spawns a temporary git worktree, gives the agent its own copy of the repo, and auto-cleans if no changes were made. If changes are made, the worktree path and branch return in the tool result.

Ant-only builds also support `isolation: remote` (CCR remote sandbox, always background).

### `maxTurns`

Stop the agent after this many agentic turns (one turn = one assistant message + tool results, including parallel tools in the same turn).

```yaml
maxTurns: 20
```

Positive integer. Useful for capping runaway loops.

### `background`

Default this agent to background execution when spawned.

```yaml
background: true
```

The orchestrator can still override per-invocation by passing `run_in_background: false`. Background agents pre-approve permissions at launch and auto-deny anything not pre-approved.

## Memory and skills

### `memory`

Persistent memory directory the agent reads and writes across runs.

```yaml
memory: project   # or user, local
```

- `user` -> `~/.claude/agent-memory/<name>/`
- `project` -> `.claude/agent-memory/<name>/` (commit to share)
- `local` -> `.claude/agent-memory-local/<name>/` (gitignore by default)

When memory is set, the loader:

- Auto-injects Read, Write, Edit into the agent's tool list (if `tools` is set and missing them).
- Adds the first 200 lines (or 25 KB) of `MEMORY.md` in the memory directory to the agent's system prompt.

Body should include explicit instructions to update memory after the task.

### `skills`

Preload skill content into the agent's system context at startup.

```yaml
skills:
  - api-conventions
  - error-handling-patterns
```

The full body of each listed skill is injected at startup. Subagents do NOT inherit skills from the parent; list every skill explicitly. Cannot preload skills with `disable-model-invocation: true`.

### `mcpServers`

Non-plugin agents only. MCP servers scoped to this agent. Each entry is either a string referencing an already-configured server, or an inline definition keyed by server name.

```yaml
mcpServers:
  # Inline definition
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
  # Reference by name
  - github
```

Inline servers connect at spawn and disconnect when the agent finishes. Plugin agents IGNORE this field.

### `hooks`

Non-plugin agents only. Lifecycle hooks scoped to the agent.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly.sh"
```

Same event schema as project hooks. Fire while the agent is active, clean up when it finishes. Plugin agents IGNORE this field.

## Lifecycle and presentation

### `color`

Display color in the task list and transcript. Accepts `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`.

```yaml
color: green
```

Pure presentation, no behavioral effect.

### `initialPrompt`

Main-agent mode only. Auto-prepended to the first user turn when this agent runs as the main session via `--agent <name>` or the `agent` setting.

```yaml
initialPrompt: "Review the working tree and identify recent changes."
```

Slash commands and skill invocations inside `initialPrompt` are processed normally. If the user also passes a prompt on launch, `initialPrompt` precedes it.

### `requiredMcpServers`

Array of MCP server name patterns that must be configured for the agent to appear in the listing. Per `loadAgentsDir.ts:hasRequiredMcpServers` and `filterAgentsByMcpRequirements`, agents whose required servers are not available at session start are filtered out so the orchestrator never sees them as delegation targets.

```yaml
requiredMcpServers:
  - playwright
  - github
```

Each pattern matches case-insensitively as a substring against available MCP server names. Use this when an agent only makes sense in sessions that have specific MCP servers configured (a `browser-tester` agent that requires Playwright MCP, a `linear-triage` agent that requires Linear MCP).

Not the same as `mcpServers`. `mcpServers` adds servers scoped to the agent; `requiredMcpServers` is a precondition gate on the agent's visibility.

## Composite examples

### Read-only researcher

```yaml
---
name: docs-researcher
description: Searches local docs and project files for usage examples. Use proactively when the user asks how to use a library or pattern.
tools: Read, Grep, Glob
model: haiku
effort: low
color: green
---
```

### Code reviewer with memory

```yaml
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: sonnet
memory: project
color: yellow
---
```

### Action-taking debugger

```yaml
---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues.
tools: Read, Edit, Bash, Grep, Glob
model: inherit
---
```

### Db-reader with conditional Bash via hook

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

### Coordinator with restricted spawning (main-thread agent)

```yaml
---
name: coordinator
description: Coordinates work across specialized agents.
tools: Agent(worker, researcher), Read, Bash
model: opus
initialPrompt: "Survey the repository state and decide which workers to spawn."
---
```

### Plugin agent with worktree isolation

```yaml
---
name: refactor-bot
description: Aggressive refactor agent. Use when migrating an entire module to a new pattern.
tools: Read, Edit, Write, Bash, Grep, Glob
model: opus
effort: high
isolation: worktree
color: red
---
```

## Plugin-agent restrictions

Per `utils/plugins/loadPluginAgents.ts:161-168`, plugin agents silently ignore (with a warning log):

- `permissionMode`
- `hooks`
- `mcpServers`

The rationale: plugins are third-party marketplace code; per-agent escalation through a buried file would bypass the install-time trust boundary. Plugins can still ship hooks and MCP servers at the manifest level (the user approved those at install).

If your agent needs `permissionMode`, `hooks`, or `mcpServers`, ship it as a user or project agent under `.claude/agents/` where the user wrote the frontmatter directly.

Plugin agents DO get one substitution pass on their system prompt:

- `${CLAUDE_PLUGIN_ROOT}` -> the plugin's root directory (use for plugin-bundled files: `Read ${CLAUDE_PLUGIN_ROOT}/templates/foo.md`).
- `${user_config.X}` -> per-plugin user-config value (sensitive keys resolve to a placeholder).

## Parsing pitfalls

- **YAML strings with colons.** Wrap in quotes: `description: "Use when X: this triggers"`.
- **Tool lists.** Both `tools: Read, Grep, Glob` (string) and `tools: [Read, Grep, Glob]` (array) work. Pick one for consistency.
- **`disallowedTools` vs `tools`.** Order matters when both are set: deny applies first to the inherited pool, then `tools` filters the result. A tool listed in both is removed.
- **`model: inherit` vs omitting `model`.** Same effect. The loader normalizes `inherit` (case-insensitive) to the inherit behavior.
- **Effort integer vs string.** `parseEffortValue` accepts string levels OR positive integers. Invalid values log a warning and fall through.
- **`memory` value validation.** Only `user`, `project`, `local` are accepted; others log a warning and the field is ignored.
- **`isolation` value validation.** Only `worktree` (and `remote` on ant builds) is accepted; others fall through.
- **`maxTurns` must be a positive integer.** Non-integer or zero/negative values log a warning and the field is ignored.
- **`name` collision.** Same-name agents across scopes resolve by priority (managed > CLI flag > project > user > plugin). Lower-priority duplicates are skipped silently. Plugin agents auto-namespace so they cannot collide directly.
- **Plugin agents and forbidden fields.** Setting `permissionMode`, `hooks`, or `mcpServers` in a plugin agent does not error, just logs a warning and silently ignores. Check `claude --debug` logs if your plugin agent is missing expected behavior.
