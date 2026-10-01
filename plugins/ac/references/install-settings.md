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

Not security-sensitive, so it merges without a prompt. All ADD-only. The one migration item that touches a security-sensitive key, the `skipDangerousModePermissionPrompt` move below, only makes an earlier opt-in take effect, and Phase 5 restates its tradeoff.

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

Removes, rewrites or moves artifacts a previous run of `/ac:install` wrote. The two hook entries
carry an install-specific fingerprint (matcher plus command), so removing them never touches
operator config, and the nested `skipDangerousModePermissionPrompt` is a path no Claude Code build
reads, so moving it cannot undo an operator's working choice. The deny-string entry and the five
env values cannot be fingerprinted: the deny entry is
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

- Move `permissions.skipDangerousModePermissionPrompt` to the top level. Earlier versions of
  this file wrote it under `permissions`, where Claude Code never reads it. When the nested key is
  `true`, set the top-level key to `true` if it is absent, then delete the nested key; show both
  in the gate diff.

### Why no hook is written

`/ac:install` writes no `hooks.*` entry of its own. Every ac hook ships through the plugin's own
`hooks.json` and needs no settings entry. That file is the roster; do not enumerate it here,
because a copy of the list went stale at four entries while the plugin had grown to seven. The
one that matters to this phase is the plan-mode `PreToolUse` block, and `permissions.deny` above
is the load-bearing guard for plan mode either way.

## Group B: security-sensitive keys, opt-in, default off

These change permission behaviour, so they are never silent. Every option starts
unchecked. Write only what the operator checks, each only when the key is absent, and do not
extend the Group C migration strip to any other current Group B key. It touches two: the former Group B key `CLAUDE_AFK_TIMEOUT_MS` `"600000"`, removed because it defeats the Group A `askUserQuestionTimeout` value, and `skipDangerousModePermissionPrompt`, moved from under `permissions`, where earlier versions of this table wrote it and nothing reads it, to the top level. Under `--dry-run`, skip the prompt and note
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
        {label: "Skip dangerous prompt", description: "skipDangerousModePermissionPrompt=true (top level). No confirmation when entering bypass mode."}
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
| Skip dangerous prompt | `skipDangerousModePermissionPrompt = true`, at the top level: Claude Code reads it there and nowhere else (2.1.286 binary; the settings reference lists it under permission settings by topic, and its example is top-level) |
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
      question: "These strip or swap tool schemas in every session's baseline. Each one changes a capability, so all are off by default.",
      multiSelect: true,
      options: [
        {label: "Unused built-ins", description: "Denies NotebookEdit, PushNotification, EndConversation, the three MCP resource tools, ShareOnboardingGuide, DesignSync, ReportFindings and the statusline-setup agent. /code-review keeps working and reports in text. Skip it if you edit Jupyter notebooks, your MCP servers expose resources, you share ONBOARDING.md links, you sync with Claude Design, or you let /statusline write your status line."},
        {label: "Scheduling stack", description: "Denies CronCreate/CronDelete/CronList, ScheduleWakeup, RemoteTrigger and TaskOutput, and turns the loop and schedule skills off. Monitor survives and covers polling and log-watching; take this only if you do not use in-session reminders or claude.ai cloud routines."},
        {label: "Task tools off", description: "env.CLAUDE_CODE_ENABLE_TASKS=false. On Opus 4.8, Sonnet 5, Opus 5 and later it changes nothing outside background sessions, because Claude Code already leaves the task-tracking tools out there. Where it still offers them (Claude 3.x, Opus 4.0 to 4.7, Sonnet 4.0 to 4.6, Haiku 4.5, and background or cloud sessions on any model), it swaps TaskCreate/TaskGet/TaskList/TaskUpdate for the single TodoWrite tool and its reminder; tracking stays. The ac plan and execute skills keep their record in files either way."}
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
| Unused built-ins | Append to `permissions.deny`: `NotebookEdit`, `PushNotification`, `EndConversation`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`, `ShareOnboardingGuide`, `DesignSync`, `ReportFindings`, `Agent(statusline-setup)` |
| Scheduling stack | Append to `permissions.deny`: `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `TaskOutput`. Also set `skillOverrides.loop` and `skillOverrides.schedule` to `"off"` |
| Task tools off | `env.CLAUDE_CODE_ENABLE_TASKS = "false"` |
| Rarely-used bundled skills | `skillOverrides` entries for `run`, `keybindings-help`, `fewer-permission-prompts`, `simplify`, `init`, `claude-api`, `update-config`, each `"user-invocable-only"` |
| Auto-mode classifier off | `env.CLAUDE_CODE_ENABLE_AUTO_MODE = "0"` |

Deny and override travel together on the scheduling stack: a skill whose tools are denied is a
dead entry that still costs its description.

`ReportFindings` needs no override. `/code-review` calls it only when env
`CLAUDE_CODE_REPORT_FINDINGS` is set and the tool is present, and otherwise prints its findings
as text (read off the 2.1.286 binary), so the deny takes the schema out of every session and
leaves `/code-review`, `/security-review` and `/batch`'s review step working. Do not turn the
`code-review` skill off to go with it: `/batch` invokes that skill by name.

For "Task tools off", report in the Phase 5 summary that an existing `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
gives `TodoWrite` to every model, including Opus 4.8 and later where it is otherwise absent, and has to
be removed by hand if the operator wants those models to run without it.

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

## Group F: marketplace auto-update, opt-in, default off

A marketplace entry in `extraKnownMarketplaces` takes an optional `autoUpdate` boolean. Omitted,
`claude-plugins-official` and most other Anthropic marketplaces update in the background after
startup and third-party ones do not, so a third-party plugin stays on whatever version was first
installed until someone runs `/plugin` by hand. Turning it on means new plugin code runs without
a review step, which is why it is a gate and not Group A.

Candidates are the entries whose `source.source` is `github`, `git` or `url`, that carry no
`autoUpdate` key at all, that are not `claude-plugins-official` (on by default), and whose entry
in `~/.claude/plugins/known_marketplaces.json` carries no `autoUpdate` either: the `/plugin`
toggle writes there, and a settings value outranks it, so writing either answer over a toggled
marketplace would override a choice the operator already made. A `directory` or `file` source
loads in place and needs nothing; an entry with `autoUpdate` already set, `false` included, is an
answer and stays untouched. Skip the question when there are no candidates, and under
`--dry-run`, where you list the candidates and say no key would be set.

The whole background pass is off while `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, unless `FORCE_AUTOUPDATE_PLUGINS=1` is too.
Check the settings `env` and `printenv` first; when one is set without the override, skip the
question, write nothing, and report in Phase 5 that `autoUpdate` would have no effect until
`env.FORCE_AUTOUPDATE_PLUGINS = "1"` is added. Order of precedence and the defaults are in
https://code.claude.com/docs/en/plugins/loading.md. Marketplaces added through `/plugin marketplace add` and never written
to `settings.json` are out of reach here; name `/plugin` as the place to change them.

```
AskUserQuestion({
  header: "Auto-update?",
  question: "These third-party marketplaces never update on their own: <comma-list of names>. Turn on background updates for all of them?",
  options: [
    {label: "Turn them on", description: "Sets autoUpdate: true on each listed entry. New plugin versions install after startup without a prompt."},
    {label: "Leave them off", description: "Writes autoUpdate: false, the value they already behave as, so a re-run does not ask again. /plugin updates them by hand."}
  ]
})
```

| Answer | Key written |
|---|---|
| Turn them on | `extraKnownMarketplaces.<name>.autoUpdate = true` on every candidate |
| Leave them off | `extraKnownMarketplaces.<name>.autoUpdate = false` on every candidate |

Writing `false` changes nothing about how the marketplace behaves; it records the answer on disk,
so the next run and `--upgrade` see an entry that already carries the key and do not ask again.

## Report-only checks

Three things cost context or duplicate work but live where this command does not write, or were
written by the operator rather than by an install. Detect each, report it in Phase 5 with the
exact line to change, and write nothing for it. Name a `settings.json` finding by its key path
rather than a line number, since the Phase 4 write moves every line after it; name a shell rc
finding by file and line.

1. **`ENABLE_TOOL_SEARCH`.** Unset, Claude Code defers every MCP tool schema behind `ToolSearch`
   on a first-party host. `auto` loads them all up front while they fit in 10% of the context
   window, which on a 1M window is nearly always, and `false` loads them all; measured on 2.1.286
   with Opus 5.5 1M, unsetting `auto` took about 9,600 tokens off every session. Check
   `printenv ENABLE_TOOL_SEARCH`, `.env.ENABLE_TOOL_SEARCH` in `~/.claude/settings.json`, and
   `grep -n -F ENABLE_TOOL_SEARCH` over `~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.bashrc`,
   `~/.bash_profile`, `~/.profile` and `~/.config/fish/config.fish`. A value in
   `settings.json` `env` also shows up in `printenv`, so report a `printenv` value on its own
   only when neither of the other two sources explains it. Say nothing when it is unset or `true`, and leave a value alone when
   `ANTHROPIC_BASE_URL` points at another host, where it may be what makes tool search work at
   all. Never edit a shell rc file.
2. **`autoUpdates`.** A top-level `autoUpdates` key in `settings.json` is not in the settings
   reference, which lists only `autoUpdatesChannel`, so it is no supported way to turn updates
   off. Report it as legacy; `env.DISABLE_AUTOUPDATER` is the key that does that, and say that
   it stops background plugin updates too, which undoes a Group F `true`.
3. **A user-level copy of the memory index hook.** The plugin ships
   `hooks/posttooluse-memory-index-budget.sh`. A `hooks.PostToolUse` entry in
   `~/.claude/settings.json` whose command names `memory-index-budget` is an earlier hand-installed
   copy, and both blocks fire on the same write. Report the entry and its command path.

## Answer record

`~/.claude/ac-install.json` remembers what this command did and what the operator turned down, so
`--upgrade` asks only what has never been answered. Every run that is not `--dry-run` writes it
at the start of Phase 5, `--skip-settings` runs included (they update the version and carry the
answers over unchanged). It holds
no secret and no setting Claude Code reads.

```json
{
  "version": "0.26.0",
  "updatedAt": "2026-10-01",
  "answers": {
    "B.auto-accept-edits": "declined",
    "D.unused-built-ins": "applied",
    "E.output-style": "declined"
  }
}
```

`version` is the `version` field of `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` at the time
of the run. `answers` maps an option id to `"applied"` or `"declined"`; merge into the existing
object rather than replacing it, so an answer from an earlier run survives a run that did not ask.
Decide each entry from the disk after the write, not from the checkbox: an option whose keys are
all present is `"applied"` (whatever their values, and whether or not it was shown, so a plain
re-run that leaves an already-applied option unchecked does not turn it into a decline); an option
that was shown, left unchecked, and whose keys are not all present is `"declined"`; any other
option keeps its earlier entry or has none. For a skill, `"applied"` means its directory exists
and `"declined"` means the operator chose Skip for a missing one. Group F records nothing here, because its answer lives on disk as the `autoUpdate` key.

| Id | Option |
|---|---|
| `B.auto-accept-edits` | Auto-accept edits |
| `B.skip-dangerous-prompt` | Skip dangerous prompt |
| `B.all-project-mcp` | All project MCP |
| `B.skip-fetch-preflight` | Skip fetch preflight |
| `B.disable-agent-teams` | Disable agent teams |
| `D.unused-built-ins` | Unused built-ins |
| `D.scheduling-stack` | Scheduling stack |
| `D.task-tools-off` | Task tools off |
| `D.rarely-used-skills` | Rarely-used bundled skills |
| `D.auto-mode-classifier-off` | Auto-mode classifier off |
| `E.output-style` | Output style |
| `S.my-coding` | The `my-coding` skill, under `--upgrade` only |
| `S.my-language` | The `my-language` skill, under `--upgrade` only |

A new option gets a new id. Never reuse or rename one: a renamed id reads as unanswered and asks
everyone again, and a reused one carries an old answer onto a different question.

### What counts as answered

An option is answered when the record holds its id, or when every key its table row writes is
already on disk, whatever its value (every deny entry present, every override and env key set).
The value does not matter because ADD-only would leave a set key alone anyway, so applying the
option would write nothing and asking would only record a choice that changes nothing. The second
test is what lets `--upgrade` work on a machine installed before the record existed, and it treats
a key the operator set by hand as applied, which is the same thing ADD-only already assumes.
`E.output-style` is the one exception: an `outputStyle` of `"default"` does not count, for the
reason Group E gives.

An option whose keys are only partly present is unanswered unless the record says `"declined"`:
asking is the only way to learn whether the rest was turned down or never offered. When an option
widens in a release, as "Unused built-ins" did with `ShareOnboardingGuide`, an `"applied"` record
does not cover the new keys, so it is unanswered while any of its keys is missing, and the question
names the missing keys. A `"declined"` record stays declined when the option widens; a plain
`/ac:install` shows every option again for an operator who wants to revisit one.

## MCP token

The ac MCP token is a secret. It is never bundled and never rendered.

1. `env.KODIZM_MCP_URL = "https://mcp.kodizm.com"`, set only when absent. Public default, safe
   to write.
2. Prompt for the `kdz-` token, or blank to skip. Write `env.KODIZM_MCP_TOKEN` only on a
   non-empty answer; a blank or skipped answer leaves the key untouched. Never echo the value,
   and never write it to a log, a diff, or the summary. Under `--dry-run`, skip this prompt.

In every rendered surface the token appears as `<set>` when newly written, `<unchanged>` when it
was already present, and is omitted entirely when skipped. No `kdz-` string is ever printed.
