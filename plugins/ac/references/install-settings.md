# `/ac:install` Phase 4 settings groups

The authoritative key list for `~/.claude/settings.json`. `/ac:install` Phase 4 cannot write
these from memory; this file is the only source. It lives outside the command body because a
slash command renders into the user prompt and competes with the user's actual request, and
because `--skip-settings` should not pay for a table it will not use.

Every write is ADD-only, with two exceptions: the Group C migration strip, which rewrites or removes a value only when it exactly matches what an earlier /ac:install wrote, and Group E, which replaces an `outputStyle` of `"default"` after the operator agrees. Outside that strip, never strip, downgrade, or overwrite a key the operator already set.
"Set only when absent" means that if the key exists at all, even with a different value, it is
left untouched. For arrays, append the missing entries and skip any already present.

## Group A: safe-silent tuning

Non-secret performance and workflow defaults. Set each only when its key is absent. No prompt.

Top level:

| Key | Value |
|---|---|
| `disableWorkflows` | `true` (the setting key, not an env duplicate; do not also write `CLAUDE_CODE_DISABLE_WORKFLOWS`) |
| `disableArtifact` | `true` |
| `alwaysThinkingEnabled` | `true` |
| `askUserQuestionTimeout` | `"never"` (the default; auto-continue stays off only while env `CLAUDE_AFK_TIMEOUT_MS` is unset, because that variable turns it on and overrides this setting) |
| `dialogExpiry` | `"never"` (a dialog forwarded to Remote Control or an SDK host, and the approval for a held cross-session message, stays open instead of cancelling after 5 minutes; local permission prompts never expire either way, and env `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` overrides this) |
| `statusLine` | `{"type": "command", "command": "bunx -y ccstatusline@latest", "padding": 0}` |

`statusLine` assumes `bun` or `npx` on PATH; say so in the Phase 5 summary.

Under `env`, all string values:

| Key | Value |
|---|---|
| `MAX_MCP_OUTPUT_TOKENS` | `"50000"` |
| `MCP_TOOL_TIMEOUT` | `"1800000"` (the built-in default is about 28 hours, but each HTTP, SSE or claude.ai connector request is cut at 60 seconds unless this or a per-server `timeout` is above 60000; a call that sends no response or progress still aborts after 5 minutes on a network server and 30 minutes on stdio, through `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` at its default) |
| `API_TIMEOUT_MS` | `"600000"` (the SDK request default; writing it also raises the non-streaming fallback timeout from its unset 300000 to 600000, and a lower value would shorten the first-byte retry window) |
| `BASH_DEFAULT_TIMEOUT_MS` | `"180000"` |
| `BASH_MAX_TIMEOUT_MS` | `"900000"` |
| `BASH_MAX_OUTPUT_LENGTH` | `"50000"` |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | `"30000"` |
| `CLAUDE_CODE_RETRY_WATCHDOG` | `"1"` (retries 429 and 529 capacity errors without limit, backing off up to 5 minutes or until the reset time the response carries; a 429 that reports a spend limit or exhausted credits still fails at once. Other transient errors get 300 attempts. Do not also write `CLAUDE_CODE_MAX_RETRIES`: under the watchdog its value replaces the 300, uncapped) |
| `CLAUDE_CODE_THRIFTY_SONIC` | `"0"` (Opus 5.5 otherwise forces a steer toward editing files through `sed` and heredocs, which skips post-edit LSP diagnostics, the stale-write guard, the user-visible diff, and every `Edit|Write` hook including the plugin's file-scope gate) |

## Group C: core ac parity

Not security-sensitive, so it merges without a prompt. All ADD-only.

1. `enabledPlugins["ac@ac"] = true`.
2. Append to `permissions.allow`: `mcp__plugin_ac_ac__*`, `WebSearch`, `WebFetch`. Create the
   array if missing, skip anything already there. Never widen to `mcp__*`.
3. Append to `permissions.deny`: `EnterPlanMode`, `ExitPlanMode`, `Agent(Plan)`, `Agent(Explore)`.
   This is the load-bearing plan-mode block.
4. `env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS = "1"`, only when absent. It removes the built-in
   Explore and Plan agents from the Agent tool's list and from the harness line that routes broad
   searches to Explore (Claude Code 2.1.198 and later), so the model reaches `ac:explore` and
   `/ac:plan` instead of a denied name. The deny entries stay for older builds.

### Migration strip for prior install versions

Removes or rewrites artifacts a previous run of `/ac:install` wrote. The two hook entries carry
an install-specific fingerprint (matcher plus command), so removing them never touches operator
config. The deny-string entry and the five env values cannot be fingerprinted: the deny entry is
stripped on the assumption a prior install wrote it, and each env value is touched only on an
exact match with the value a prior install wrote.

- Remove any `WebSearch` or `WebFetch` entry from `permissions.deny`. These plain strings are
  indistinguishable from an operator-authored deny, so someone who denies them on purpose will
  see it removed on a re-run and must re-add it. Surface the removal in the gate diff.
- Remove any `hooks.PreToolUse` entry whose matcher equals `WebSearch|WebFetch`.
- Remove the `hooks.PreToolUse` entry a prior install wrote for plan mode: matcher
  `EnterPlanMode`, command echoing the `use /ac:plan` steer and exiting 2.
- Rewrite or remove five env values a prior install wrote, matched by exact value so an operator's own
  choice survives: `API_TIMEOUT_MS` `"30000"` becomes `"600000"`, `MCP_TOOL_TIMEOUT` `"60000"`
  becomes `"1800000"`, and `MCP_TIMEOUT` `"30000"` and `CLAUDE_CODE_MAX_RETRIES` `"15"` are
  removed (`CLAUDE_CODE_MAX_RETRIES` only when `CLAUDE_CODE_RETRY_WATCHDOG` ends up set, since without the watchdog removing it drops retries from 15 to 10). Remove `CLAUDE_AFK_TIMEOUT_MS` `"600000"` too: it was an opt-in here once, and it
  auto-submits every AskUserQuestion after ten minutes even when `askUserQuestionTimeout` is
  `"never"`. List every rewrite in the gate diff.

### Why no hook is written

`/ac:install` writes no `hooks.*` entry of its own. Every ac hook ships through the plugin's own
`hooks.json` and needs no settings entry. That file is the roster; do not enumerate it here,
because a copy of the list went stale at four entries while the plugin had grown to seven. The
one that matters to this phase is the plan-mode `PreToolUse` block, and `permissions.deny` above
is the load-bearing guard for plan mode either way.

## Group B: security-sensitive keys, opt-in, default off

These change permission behaviour, so they are never silent. Every option starts
unchecked. Write only what the operator checks, each only when the key is absent, and do not
extend the Group C migration strip to any current Group B key. The one former Group B key it touches, `CLAUDE_AFK_TIMEOUT_MS` `"600000"`, is removed because it defeats the Group A `askUserQuestionTimeout` value. Under `--dry-run`, skip the prompt and note
that no security-sensitive key would be set.

`AskUserQuestion` caps a question at four options, so these five split across two questions in
one call. `/ac:install` writes, rewrites and removes no telemetry key in any group, including any an earlier version wrote.

```
AskUserQuestion({
  questions: [
    {
      header: "Permissions?",
      question: "These loosen a permission gate and are off by default. Each is added only when the key is absent; nothing you already set is changed.",
      multiSelect: true,
      options: [
        {label: "Auto-accept edits", description: "permissions.defaultMode=acceptEdits. Edits apply without a per-edit prompt."},
        {label: "Skip dangerous prompt", description: "permissions.skipDangerousModePermissionPrompt=true. No confirmation when entering bypass mode."}
      ]
    },
    {
      header: "Loading?",
      question: "These change what loads without asking. Same ADD-only rule.",
      multiSelect: true,
      options: [
        {label: "All project MCP", description: "enableAllProjectMcpServers=true. Every project-scoped MCP server loads without asking."},
        {label: "Skip fetch preflight", description: "skipWebFetchPreflight=true. Drops the per-fetch domain-safety blocklist preflight (a hang source) at the cost of that safety check."},
        {label: "Disable agent teams", description: "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0."}
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
| Disable agent teams | `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0"` |

An unchecked option writes nothing.

## Group D: context trim, opt-in, default off

Every session pays for tool schemas and bundled skill descriptions whether or not they are used, because `permissions.deny` strips a tool's SCHEMA rather than only blocking
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
        {label: "Task tools off", description: "env.CLAUDE_CODE_ENABLE_TASKS=false. Claude Code already leaves the task-tracking tools out on Opus 4.8, Sonnet 5, Opus 5 and later. Where it still offers them (Opus 4.0 to 4.7, Sonnet 4.x, Haiku 4.5, and background sessions on any model), this swaps TaskCreate/TaskGet/TaskList/TaskUpdate for the single TodoWrite tool and its reminder; it does not remove tracking. The ac plan and execute skills keep their record in files either way."}
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

For "Task tools off", report in the Phase 5 summary that an existing `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
brings `TodoWrite` back on every model, and has to be removed by hand if the operator wants no
tracking tool at all.

`skillOverrides` takes a string enum, `"on"`, `"name-only"`, `"user-invocable-only"` or `"off"`;
an object value there raises a settings validation error per key. `"name-only"` lists the skill
without its description, `"user-invocable-only"` hides it from the model but keeps `/name`, and
`"off"` hides it from both. Anything the operator should still be able to type stays on
`"user-invocable-only"`, which is why the rarely-used list does not use `"off"`.

## Group E: output style, opt-in, default off

The plugin ships one output style, at `plugins/ac/output-styles/concise.md`. It sets no
`force-for-plugin`, so nothing applies it until the operator asks for it here or through
`/config`. It is neither security-sensitive (Group B) nor a context trim (Group D), which is
why it has its own gate rather than a home in either; it changes the shape of every answer, so
it is never silent. No option is marked recommended: this is a preference, not a fact.

```
AskUserQuestion({
  header: "Output style?",
  question: "The ac plugin ships an output style, ac:concise. It leads with the result, keeps an answer to a few sentences, gives full depth the moment you ask, and never shortens error output or a security warning. Turn it on?",
  options: [
    {label: "Turn it on", description: "Sets outputStyle to ac:concise. Takes effect at the next session start, not this one."},
    {label: "Leave it off", description: "Nothing is written. Your global CLAUDE.md still carries the one-line answer-shape floor, and /config turns the style on at any time."}
  ]
})
```

| Answer | Key written |
|---|---|
| Turn it on | `outputStyle = "ac:concise"` |
| Leave it off | nothing |

ADD-only like every other group. When `outputStyle` already holds any value other than
`default`, including a built-in such as `Explanatory`, leave it untouched and report it as
already present; do not ask, because the operator has already answered this question elsewhere.

`default` is the one exception, because it is definitionally the no-style value: the runtime
maps that name to null rather than to a style. Someone who opened `/config` once and picked
Default has a key set and no style active, so counting it as an answer would withhold the
question from exactly the person it exists for.

Under `--dry-run`, skip the prompt and say the key would not be set.

The value is the literal string `ac:concise`. A plugin-shipped style resolves as
`<plugin name>:<style name>`, and a value that does not resolve returns null with no warning
anywhere in the binary, so a wrong value is indistinguishable from the key being absent.
Measured on 2.1.260: `ac:concise` resolves, bare `concise` does not, and neither does
`concise@ac` or `ac@ac:concise`.

That silent miss is why Phase 5 asks the operator to confirm the active style in `/config`
rather than only reporting that the key was written.

## MCP token

The ac MCP token is a secret. It is never bundled and never rendered.

1. `env.KODIZM_MCP_URL = "https://mcp.kodizm.com"`, set only when absent. Public default, safe
   to write.
2. Prompt for the `kdz-` token, or blank to skip. Write `env.KODIZM_MCP_TOKEN` only on a
   non-empty answer; a blank or skipped answer leaves the key untouched. Never echo the value,
   and never write it to a log, a diff, or the summary. Under `--dry-run`, skip this prompt.

In every rendered surface the token appears as `<set>` when newly written, `<unchanged>` when it
was already present, and is omitted entirely when skipped. No `kdz-` string is ever printed.
