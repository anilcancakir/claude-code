# `/ac:install` Phase 4 settings groups

The authoritative key list for `~/.claude/settings.json`. `/ac:install` Phase 4 cannot write
these from memory; this file is the only source. It lives outside the command body because a
slash command renders into the user prompt and competes with the user's actual request, and
because `--skip-settings` should not pay for a table it will not use.

Every write is ADD-only. Never strip, downgrade, or overwrite a key the operator already set.
"Set only when absent" means that if the key exists at all, even with a different value, it is
left untouched. For arrays, append the missing entries and skip any already present.

## Group A: safe-silent tuning

Non-secret performance and workflow defaults. Set each only when its key is absent. No prompt.

Top level:

| Key | Value |
|---|---|
| `disableWorkflows` | `true` (the setting key, not an env duplicate; do not also write `CLAUDE_CODE_DISABLE_WORKFLOWS`) |
| `disableArtifact` | `true` |
| `effortLevel` | `"xhigh"` |
| `alwaysThinkingEnabled` | `true` |
| `statusLine` | `{"type": "command", "command": "bunx -y ccstatusline@latest", "padding": 0}` |

`statusLine` assumes `bun` or `npx` on PATH; say so in the Phase 5 summary.

Under `env`, all string values:

| Key | Value |
|---|---|
| `MAX_MCP_OUTPUT_TOKENS` | `"50000"` |
| `MCP_TIMEOUT` | `"30000"` |
| `MCP_TOOL_TIMEOUT` | `"60000"` |
| `API_TIMEOUT_MS` | `"30000"` |
| `BASH_DEFAULT_TIMEOUT_MS` | `"180000"` |
| `BASH_MAX_TIMEOUT_MS` | `"900000"` |
| `BASH_MAX_OUTPUT_LENGTH` | `"50000"` |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | `"30000"` |
| `CLAUDE_CODE_MAX_RETRIES` | `"15"` (clamped at 15; do not raise it) |

## Group C: core ac parity

Not security-sensitive, so it merges without a prompt. All ADD-only.

1. `enabledPlugins["ac@ac"] = true`.
2. Append to `permissions.allow`: `mcp__plugin_ac_ac__*`, `WebSearch`, `WebFetch`. Create the
   array if missing, skip anything already there. Never widen to `mcp__*`.
3. Append to `permissions.deny`: `EnterPlanMode`, `ExitPlanMode`, `Agent(Plan)`, `Agent(Explore)`.
   This is the load-bearing plan-mode block.

### Migration strip for prior install versions

Removes artifacts a previous run of `/ac:install` wrote. The two hook entries carry an
install-specific fingerprint (matcher plus command), so removing them never touches operator
config. The deny-string entry cannot be fingerprinted and is stripped on the assumption a prior
install wrote it.

- Remove any `WebSearch` or `WebFetch` entry from `permissions.deny`. These plain strings are
  indistinguishable from an operator-authored deny, so someone who denies them on purpose will
  see it removed on a re-run and must re-add it. Surface the removal in the gate diff.
- Remove any `hooks.PreToolUse` entry whose matcher equals `WebSearch|WebFetch`.
- Remove the `hooks.PreToolUse` entry a prior install wrote for plan mode: matcher
  `EnterPlanMode`, command echoing the `use /ac:plan` steer and exiting 2.

### Why no hook is written

`/ac:install` writes no `hooks.*` entry of its own. Every ac hook ships through the plugin's own
`hooks.json` and needs no settings entry. That file is the roster; do not enumerate it here,
because a copy of the list went stale at four entries while the plugin had grown to seven. The
one that matters to this phase is the plan-mode `PreToolUse` block, and `permissions.deny` above
is the load-bearing guard for plan mode either way.

## Group B: security-sensitive keys, opt-in, default off

These change permission or telemetry behaviour, so they are never silent. Every option starts
unchecked. Write only what the operator checks, each only when the key is absent, and do not
extend the Group C migration strip to any of them. Under `--dry-run`, skip the prompt and note
that no security-sensitive key would be set.

`AskUserQuestion` caps a question at four options, so these seven split across two questions in
one call.

```
AskUserQuestion({
  questions: [
    {
      header: "Permissions?",
      question: "These loosen a permission gate and are off by default. Each is added only when the key is absent; nothing you already set is changed.",
      multiSelect: true,
      options: [
        {label: "Auto-accept edits", description: "permissions.defaultMode=acceptEdits. Edits apply without a per-edit prompt."},
        {label: "Skip dangerous prompt", description: "permissions.skipDangerousModePermissionPrompt=true. No confirmation when entering bypass mode."},
        {label: "All project MCP", description: "enableAllProjectMcpServers=true. Every project-scoped MCP server loads without asking."},
        {label: "Skip fetch preflight", description: "skipWebFetchPreflight=true. Drops the per-fetch domain-safety blocklist preflight (a hang source) at the cost of that safety check."}
      ]
    },
    {
      header: "Env keys?",
      question: "These set environment keys that change timeout, team and telemetry behavior. Same ADD-only rule.",
      multiSelect: true,
      options: [
        {label: "AFK timeout 10m", description: "env.CLAUDE_AFK_TIMEOUT_MS=600000."},
        {label: "Disable agent teams", description: "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0."},
        {label: "OTEL telemetry", description: "env.CLAUDE_CODE_ENABLE_TELEMETRY=1 plus OTEL_METRICS_EXPORTER=otlp, OTEL_EXPORTER_OTLP_PROTOCOL=grpc, OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317. Exports metrics to a local collector."}
      ]
    }
  ]
})
```

| Checked option | Keys written |
|---|---|
| Auto-accept edits | `permissions.defaultMode = "acceptEdits"` |
| Skip dangerous prompt | `permissions.skipDangerousModePermissionPrompt = true` |
| All project MCP | `enableAllProjectMcpServers = true` |
| Skip fetch preflight | `skipWebFetchPreflight = true` |
| AFK timeout 10m | `env.CLAUDE_AFK_TIMEOUT_MS = "600000"` |
| Disable agent teams | `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0"` |
| OTEL telemetry | `env.CLAUDE_CODE_ENABLE_TELEMETRY = "1"`, `env.OTEL_METRICS_EXPORTER = "otlp"`, `env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc"`, `env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317"` |

An unchecked option writes nothing.

## Group D: context trim, opt-in, default off

Every session pays for tool schemas, bundled skill descriptions and the task toolset whether or
not they are used, because `permissions.deny` strips a tool's SCHEMA rather than only blocking
the call. Each option below takes that cost off the baseline and takes a capability with it, so
none is silent. No saving figure is quoted here: a tool that already defers costs its name
rather than its schema, so the number moves with the build and with whether tool search is on.
Measure it on the operator's own machine with `claude -p "ok" --output-format json` before and
after if it matters to the decision. Under `--dry-run`, skip the prompt and note that no trim
would be applied.

```
AskUserQuestion({
  questions: [
    {
      header: "Trim tools?",
      question: "These strip tool schemas out of every session's baseline. Each one removes a capability, so all are off by default.",
      multiSelect: true,
      options: [
        {label: "Unused built-ins", description: "Denies NotebookEdit, PushNotification, EndConversation and the three MCP resource tools. Skip it if you edit Jupyter notebooks or your MCP servers expose resources."},
        {label: "Scheduling stack", description: "Denies CronCreate/CronDelete/CronList, ScheduleWakeup, RemoteTrigger and TaskOutput, and turns the loop and schedule skills off. Monitor survives and covers polling and log-watching; take this only if you do not use in-session reminders or claude.ai cloud routines."},
        {label: "Task tools off", description: "env.CLAUDE_CODE_ENABLE_TASKS=false. Drops TaskCreate/TaskGet/TaskList/TaskUpdate, worth about 2,500 tokens of schema on every turn. Verified on 2.1.259: nothing replaces them, TodoWrite included, so multi-step work needs a file or a rendered table to keep its record. The ac plan and execute skills already work this way."}
      ]
    },
    {
      header: "Trim skills?",
      question: "These hide rarely-used surfaces from the model without uninstalling them.",
      multiSelect: true,
      options: [
        {label: "Rarely-used bundled skills", description: "Hides run, keybindings-help, fewer-permission-prompts, simplify, init, claude-api and update-config from the model. Every one stays reachable by typing /name."},
        {label: "Auto-mode classifier off", description: "env.CLAUDE_CODE_ENABLE_AUTO_MODE=0. Stops the separate model call that classifies every permission decision under permissions.defaultMode=auto. Saves no context; removes latency and per-call cost."}
      ]
    }
  ]
})
```

| Checked option | Keys written |
|---|---|
| Unused built-ins | Append to `permissions.deny`: `NotebookEdit`, `PushNotification`, `EndConversation`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool` |
| Scheduling stack | Append to `permissions.deny`: `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `TaskOutput`. Also set `skillOverrides.loop` and `skillOverrides.schedule` to `"off"` |
| Task tools off | `env.CLAUDE_CODE_ENABLE_TASKS = "false"` |
| Rarely-used bundled skills | `skillOverrides` entries for `run`, `keybindings-help`, `fewer-permission-prompts`, `simplify`, `init`, `claude-api`, `update-config`, each `"user-invocable-only"` |
| Auto-mode classifier off | `env.CLAUDE_CODE_ENABLE_AUTO_MODE = "0"` |

Deny and override travel together on the scheduling stack: a skill whose tools are denied is a
dead entry that still costs its description.

For "Task tools off", report in the Phase 5 summary that an existing `CLAUDE_CODE_ENABLE_TODO_TOOLS`
key re-adds the four tools and has to be removed by hand.

`skillOverrides` takes a string enum, `"on"`, `"name-only"`, `"user-invocable-only"` or `"off"`;
an object value there raises a settings validation error per key. `"name-only"` lists the skill
without its description, `"user-invocable-only"` hides it from the model but keeps `/name`, and
`"off"` hides it from both. Anything the operator should still be able to type stays on
`"user-invocable-only"`, which is why the rarely-used list does not use `"off"`.

## MCP token

The ac MCP token is a secret. It is never bundled and never rendered.

1. `env.KODIZM_MCP_URL = "https://mcp.kodizm.com"`, set only when absent. Public default, safe
   to write.
2. Prompt for the `kdz-` token, or blank to skip. Write `env.KODIZM_MCP_TOKEN` only on a
   non-empty answer; a blank or skipped answer leaves the key untouched. Never echo the value,
   and never write it to a log, a diff, or the summary. Under `--dry-run`, skip this prompt.

In every rendered surface the token appears as `<set>` when newly written, `<unchanged>` when it
was already present, and is omitted entirely when skipped. No `kdz-` string is ever printed.
