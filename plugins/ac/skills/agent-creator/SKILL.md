---
name: agent-creator
description: "Create or audit a Claude Code subagent: tools, model and effort, permissions, memory, isolation, and the system-prompt body."
when_to_use: "Use when writing, editing or debugging a subagent definition."
---

# Agent Creator

You are about to write or edit a Claude Code subagent another Claude will delegate to. An agent is a markdown file: the frontmatter sets its tools, model and runtime; the body becomes its whole system prompt. The parent calls the Agent tool with `subagent_type`, a `prompt` and optional `description`, `model`, `effort`, `run_in_background` or `isolation`; the agent runs in a fresh context and only its final message returns to the parent. Checked against Claude Code 2.1.314 on 2026-10-31.

The body is a prompt: route its wording through `ac:prompt-writer` and its shape through the five-section pattern below. This file owns the agent-specific decisions.

## Rules that hold for every agent

1. **The body is the whole system prompt.** The main thread's persona, tone and Claude Code's built-in rules do not reach a subagent; every rule it follows lives in its body. CLAUDE.md does reach it unless `omitClaudeMd: true`.
2. **Context isolation is the value.** The parent sees only the final message, so the Output Format is a locked contract the parent can act on without follow-up questions.
3. **Minimal frontmatter.** `name` and `description` are required; add any other field only when you can name the condition.
4. **Decide nesting on purpose.** A denylist inherits the Agent tool and the agent will spawn children; an allowlist without `Agent` cannot.
5. **Plugin agents are restricted.** They ignore `permissionMode`, `hooks`, `mcpServers` and `initialPrompt`; an agent that needs them ships as a user or project agent.
6. **Plain wording, scope in both directions.** No caps; name what the agent does and where it stops.

## Decision flow

```
Is a custom subagent the right tool?
├── A built-in agent already fits → use it (on an `/ac:install` setup Explore and Plan are disabled; use `ac:explore` or `general-purpose`).
├── A repeatable procedure with no need for isolation → a skill, via `ac:skill-creator`.
├── A user-typed `/name [args]` workflow → a skill, via `ac:skill-creator` and its user-typed reference; a `context: fork` skill can run it in an agent.
├── Must happen deterministically → a hook, via `update-config`.
├── A standing fact → CLAUDE.md or a rule, via `ac:claude-md-rules-creator`.
└── Recurring work that benefits from its own context, tools or model → an agent. Continue.

Where does it live?
├── Project → `.claude/agents/<name>.md` (commit to share)
├── Personal → `~/.claude/agents/<name>.md`
├── Plugin → `<plugin>/agents/<name>.md`, addressed as `<plugin>:<name>`
├── Org-wide → managed directory
└── One run → the `--agents` JSON flag

Auditing an existing agent? → `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` first.
```

Definitions with the same name resolve managed > `--agents` > project > user > plugin > built-in. `--add-dir` directories are not scanned for agents.

## Frontmatter

> **Escape convention.** This SKILL.md is preprocessed, so tokens named rather than used appear with `&#36;` for the dollar sign. In a plugin agent body, write a plain `$`.

| Field | Default | Semantics, and when to set it |
|-------|---------|-------------------------------|
| `name` | required | Identifier the parent delegates to; lowercase and hyphens, at most 256 characters, no `:` |
| `description` | required | The delegation trigger the parent reads |
| `tools` | every parent tool | Allowlist; comma string or YAML list. `Agent(x, y)` limits which types it may spawn |
| `disallowedTools` | none | Denylist; applied to the inherited pool before `tools` filters it |
| `model` | `inherit` | `sonnet`, `opus`, `haiku`, `fable`, a full model id, or `inherit` |
| `effort` | session effort | `low`, `medium`, `high`, `xhigh`, `max`; the Agent tool's `effort` parameter overrides it (2.1.292) |
| `permissionMode` | parent's | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. Ignored on plugin agents |
| `maxTurns` | none | Positive integer cap on agentic turns |
| `autoCompactWindow` | inherited | Compaction threshold for the subagent, 100000 to 1000000; only lowers the inherited window (2.1.296) |
| `skills` | none | Skill bodies preloaded at start; at most 32 (2.1.295); plugin skills as `<plugin>:<name>`; `disable-model-invocation` skills cannot be preloaded |
| `mcpServers` | none | Servers scoped to the agent, inline or by name. Ignored on plugin agents |
| `hooks` | none | Hooks active while the agent runs. Ignored on plugin agents |
| `memory` | none | `user`, `project` or `local`: a persistent directory the agent reads and updates |
| `background` | `false` | `true` spawns it in the background by default |
| `omitClaudeMd` | `false` | `true` drops the CLAUDE.md hierarchy from its context (2.1.271) |
| `isolation` | none | `worktree` runs it in a temporary git worktree |
| `color` | none | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` |
| `initialPrompt` | none | First user turn when the agent runs as the main session (`--agent`). Ignored on plugin agents |
| `experimental.cacheTtl` | `5m` | `5m` or `1h` prompt-cache lifetime, for an agent that idles longer than five minutes between turns (2.1.248) |

`requiredMcpServers` (server-name substrings that must be configured for the agent to be listed) also parses; detail and every field's pitfalls: `${CLAUDE_SKILL_DIR}/references/frontmatter.md`. `claude --debug` names unknown fields with a typo hint (2.1.296), so a misspelt field shows up there instead of failing silently.

Copying every optional field "just in case" is the common mistake. A focused researcher needs `name`, `description`, `tools` and `model`; a reviewer that learns adds `memory`.

## Tools and nesting

| Shape | Frontmatter | Use for |
|-------|-------------|---------|
| Allowlist | `tools: Read, Grep, Glob, Bash` | Focused agents; the default for read-only researchers |
| Denylist | `disallowedTools: Write, Edit, NotebookEdit` | "Anything except touching files" |
| Both | both fields | Denylist first, then the allowlist filters the rest |

The Agent tool is a tool like any other. A denylist-only agent inherits it and, on current Opus models, will delegate; an allowlist that omits `Agent` blocks spawning, and `tools: Agent(worker, researcher)` limits it to those types. Nesting reaches 3 levels by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) and at most 20 agents run concurrently. Keep multi-agent chains orchestrator-driven where cost and order matter: the agent returns a report naming the next agent and the parent spawns it.

An allowlist also changes tool loading: without `ToolSearch` in the pool, deferred tools such as `LSP` ship inline instead of behind a search round-trip. An agent whose body requires LSP belongs on an allowlist that names it. Detail and templates: `${CLAUDE_SKILL_DIR}/references/tool-restrictions.md`.

## Model and effort

- **haiku**: fast and cheap; search, lookup, classification. On the Anthropic API it is Haiku 5.5, which takes `effort`; on Bedrock, Vertex, Foundry and Claude Platform on AWS it is Haiku 4.5, which takes none, so do not pair `haiku` with `effort` for those providers.
- **sonnet**: balanced; review, analysis, standard implementation.
- **opus**: deep reasoning; architecture, cross-file refactors, adversarial review.
- **fable**: the tier above Opus, for the hardest single-shot work.
- **inherit**: the agent's quality tracks the session's choice.

Effort precedence, highest first: the `CLAUDE_CODE_EFFORT_LEVEL` environment variable, the Agent tool's `effort` parameter, the agent's `effort` field, the session effort. Set the field only when the agent's work needs a different level from the session; per-model calibration is in `ac:prompt-writer`.

## Permissions, memory, isolation

`permissionMode` works on user and project agents only. A parent running `bypassPermissions` or `acceptEdits` takes precedence, and a parent in `auto` makes the agent's mode irrelevant. Most agents leave it unset and constrain capability through tools.

`memory: project` (or `user`, `local`) gives the agent a persistent directory; Read, Write and Edit are added to its tools, the start of its `MEMORY.md` is added to its system prompt, and the body must say when to update it. Use it for reviewers and analysts that benefit from accumulated knowledge.

`skills:` injects each listed skill's full body at start; subagents do not inherit the parent's skills. A skill that cannot be resolved is skipped with only a debug line.

`isolation: worktree` gives the agent its own checkout; an unchanged worktree is cleaned up, a changed one returns its path and branch. Use it for agents that must not touch the main checkout or that run in parallel.

Detail: `${CLAUDE_SKILL_DIR}/references/memory-and-skills.md`.

## Body: the five-section pattern

```markdown
## Identity
One or two sentences: who the agent is and what it returns.

## Execution
Numbered steps; read first, then act. Sub-numbers for parallel steps.

## Output Format
The exact shape the parent parses: headers, citation format, length cap.

## Failure Conditions
FAILED if: the quality-gate violations the agent checks itself against.

## Constraints
Scope limits, tool restrictions restated, evidence requirements.
```

Each section has a success criterion the agent can check. Plugin agent bodies get one substitution pass, `&#36;{CLAUDE_PLUGIN_ROOT}` and `&#36;{user_config.X}`; other agents get none. Agents never get argument substitution, the skill-directory token or shell injection. Depth and three worked structures: `${CLAUDE_SKILL_DIR}/references/system-prompt-structure.md`.

## Workflow

### 1. Capture intent

Always ask what it does in one sentence, whether it reads or writes, which model fits, and the scope. Ask about tool limits, memory, preloaded skills, permission mode or a worktree only when the answers imply them.

**Success criterion**: each optional field you will set has a named reason.

### 2. Write the frontmatter

```yaml
---
name: <kebab-case-name>
description: <Role noun. Use this when <situation>. Returns <shape>.>
---
```

Write `description` the way Claude Code writes its built-in agents: a role noun, one "Use this when" sentence, then what it returns, about 200 characters. Name a knob the caller sets in the brief, as the built-in Explore names its breadth levels. An agent only one caller spawns ends with "Spawned only by <caller>; not for general tasks." Skip "use proactively"; the Agent tool's own description already governs how readily the parent delegates.

### 3. Write the body

The five sections, worded through `ac:prompt-writer`. Restate every rule the agent needs, including any CLAUDE.md rule it loses to `omitClaudeMd`.

### 4. Verify

1. Frontmatter parses, and `claude --debug` reports no unknown field.
2. The description would make the parent delegate on a relevant request and not on a neighbouring one.
3. Tools match the body: a read-only agent has no Write or Edit; every tool the body calls is present.
4. The Output Format is parseable without follow-up.
5. A fresh-session delegation returns the expected shape.

Worked agents: `${CLAUDE_SKILL_DIR}/references/examples.md`.

### 5. Iterate

| Symptom | Fix |
|---------|-----|
| Never delegated to | Name the situation more exactly in "Use this when", or name the agent in CLAUDE.md for the work it owns |
| Delegated too eagerly | Remove broad words; say when not to use it |
| Does the wrong thing | Clearer Identity, explicit steps, locked Output Format |
| Writes files it should not | `disallowedTools: Write, Edit, NotebookEdit`, or an allowlist |
| Runs forever | `maxTurns` |
| Forgets across runs | `memory` plus an update instruction in the body |
| Re-discovers known patterns | Preload the domain skills through `skills:` |
| Spawns children unasked | An allowlist without `Agent`, or `Agent` in `disallowedTools` |
| A field seems ignored | `claude --debug`; on a plugin agent check the four ignored fields |

Deeper mapping: `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`.

## Sibling skills

| Producing | Route shape through | Use this skill for |
|---|---|---|
| File scope, naming, listing budget | `ac:skill-creator` | Agent-specific fields and body structure |
| The system-prompt wording | `ac:prompt-writer` | The five-section pattern |
| A `/name` workflow that delegates to an agent | `ac:skill-creator` (user-typed skills) | Whether an agent is needed at all, or a `context: fork` skill |
| CLAUDE.md or `.claude/rules/<topic>.md` | `ac:claude-md-rules-creator` | Persistent context versus an isolated agent |
| PROJECT.md or DESIGN.md | `ac:project-md-writer`, `ac:design-md-writer` | What the agent reads on demand versus what its body carries |
| Hook configuration | `update-config` | Deterministic enforcement versus an agent's judgment |

## Built-in agents

Explore (Haiku, read-only search), Plan (read-only architect), general-purpose (all tools, the fork default), claude-code-guide (questions about Claude Code and the API), statusline-setup. Check whether one fits before writing a custom agent. Case studies: `${CLAUDE_SKILL_DIR}/references/builtin-catalog.md`.

## Pre-flight checklist

- [ ] Right scope; filename equals `name` (at most 256 characters, no `:`).
- [ ] `description`: role noun, one "Use this when" sentence, what it returns, about 200 characters.
- [ ] Every optional field has a named reason.
- [ ] (`tools`) lists what the body uses; `Agent` present only if nesting is wanted.
- [ ] (`skills`) each exists, none has `disable-model-invocation: true`, at most 32, plugin skills qualified.
- [ ] (`memory`) the body says when to update it.
- [ ] (Plugin agent) no `permissionMode`, `hooks`, `mcpServers` or `initialPrompt`.
- [ ] Body follows the five sections and restates every rule it needs.
- [ ] Output Format is locked and parseable.
- [ ] A fresh-session delegation returns the right shape.

## References

| File | Load when... |
|---|---|
| `${CLAUDE_SKILL_DIR}/references/frontmatter.md` | Designing or auditing frontmatter: every field, values, precedence, plugin-agent restrictions, parsing pitfalls. |
| `${CLAUDE_SKILL_DIR}/references/system-prompt-structure.md` | Writing the body: the five sections in depth and three worked structures. |
| `${CLAUDE_SKILL_DIR}/references/tool-restrictions.md` | Allowlist or denylist, `Agent(x, y)`, conditional Bash through hooks. |
| `${CLAUDE_SKILL_DIR}/references/memory-and-skills.md` | Persistent memory or preloaded skills. |
| `${CLAUDE_SKILL_DIR}/references/builtin-catalog.md` | Case studies from the built-in agents. |
| `${CLAUDE_SKILL_DIR}/references/examples.md` | Worked agents to copy and adapt. |
| `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` | Diagnosing or auditing an agent. |
| `${CLAUDE_SKILL_DIR}/assets/AGENT.template.md` | Starting from a blank annotated template. |

Sibling skills are reached by invocation (`/ac:skill-creator`, `/ac:prompt-writer`), not by path.

Canonical documentation (append `.md` for raw markdown): subagents `https://code.claude.com/docs/en/sub-agents.md`, skills `https://code.claude.com/docs/en/skills.md`, plugins `https://code.claude.com/docs/en/plugins-reference.md`, permission modes `https://code.claude.com/docs/en/permission-modes.md`, hooks `https://code.claude.com/docs/en/hooks.md`. When the docs and the live binary disagree, trust the binary.
