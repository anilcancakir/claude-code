# Memory and Preloaded Skills

Two features that make an agent stateful or domain-specialized: `memory:` for persistent knowledge that accumulates across runs, and `skills:` for preloading expert knowledge at startup. Read this when adding either to an agent.

Source of truth: `tools/AgentTool/loadAgentsDir.ts`, `tools/AgentTool/agentMemory.ts`, and `tools/AgentTool/built-in/<name>.ts` in the CC source.

## Contents

- Persistent memory (`memory:`)
- Memory directory layout
- MEMORY.md auto-injection
- Auto-injected tools
- Body conventions for memory-enabled agents
- Skill preloading (`skills:`)
- Skill content lifecycle in agents
- What cannot be preloaded
- When to use memory vs skills vs both

## Persistent memory (`memory:`)

Frontmatter:

```yaml
memory: project    # or user, or local
```

Creates a directory the agent reads from at startup and writes to during work. Three scopes:

| Scope | Path | Shared via | Use when |
|-------|------|-----------|----------|
| `user` | `~/.claude/agent-memory/<name>/` | Personal across projects | The agent's knowledge applies regardless of project (general code-review patterns, debugging instincts) |
| `project` | `.claude/agent-memory/<name>/` | Commit to git | The agent's knowledge is project-specific and shareable (codebase conventions, recurring issues) |
| `local` | `.claude/agent-memory-local/<name>/` | Gitignored by default | The agent's knowledge is project-specific but private (personal notes, session-specific scratch) |

`project` is the recommended default unless you have a specific reason to scope wider or narrower.

## Memory directory layout

When you set `memory:`, the agent's memory directory is created on first run. The agent owns the contents; the directory typically grows over time as the agent saves what it learns.

Convention (not enforced by CC):

```
.claude/agent-memory/code-reviewer/
├── MEMORY.md              # Top-level summary (auto-injected into prompt)
├── patterns.md            # Discovered patterns and conventions
├── recurring-issues.md    # Known bugs and fix templates
└── architecture-notes.md  # System-level observations
```

The agent decides the layout. The orchestrator just creates the directory; the agent populates it.

## MEMORY.md auto-injection

If `MEMORY.md` exists in the memory directory, the loader injects its first 200 lines (or 25 KB, whichever comes first) into the agent's system prompt at spawn time. This is how the agent "remembers" between runs without explicitly reading the file.

If `MEMORY.md` exceeds the cap, the loader truncates and the agent receives instructions to curate the file. The agent should respect the cap by keeping `MEMORY.md` focused on durable patterns; details overflow into other files in the directory.

The auto-injection happens once per spawn. The agent CAN Read other files in the memory directory during work (Read is auto-injected for memory-enabled agents).

## Auto-injected tools

When `memory:` is set, the loader auto-adds Read, Write, and Edit to the agent's tool list if they were missing (per `tools/AgentTool/loadAgentsDir.ts` and `utils/plugins/loadPluginAgents.ts:186-197`). This applies whether `tools:` is set or omitted:

- If `tools:` is omitted (inherit all): no change needed; Read/Write/Edit already inherited.
- If `tools: Bash, Grep` is set: loader appends Read, Write, Edit so the agent can manage memory.

The agent CAN use these tools on memory files OR on other project files (the tool restriction is global, not scoped to memory). If you want memory-only file access, pair with a `PreToolUse` hook that blocks Write outside the memory directory.

## Body conventions for memory-enabled agents

Treat MEMORY.md as the agent's institutional knowledge. Body should:

1. **Read memory first.** Instruct the agent to consult MEMORY.md (already injected via system prompt) and any sub-files before starting work.
2. **Apply memory.** When acting, follow patterns documented in memory rather than re-discovering them.
3. **Update memory after the task.** Save new patterns, recurring issues, architectural decisions back to MEMORY.md.
4. **Curate MEMORY.md.** Keep it under the 200-line / 25-KB cap. Move detail to sub-files; MEMORY.md is the index.

Example body excerpt for a memory-enabled code-reviewer:

```markdown
## Execution

1. Read MEMORY.md (already in your system prompt) for patterns and recurring issues seen in prior reviews.
2. Run `git diff` to see recent changes. Focus on modified files.
3. Review against the checklist below AND against the patterns in MEMORY.md.
4. Before returning, append new patterns or refinements to MEMORY.md. Keep it under 200 lines; overflow detail into `.claude/agent-memory/code-reviewer/patterns.md`.

## Update memory format

When you discover a new pattern worth keeping, append a one-line entry to MEMORY.md:

`- <pattern name>: <one-line description>. See file:line for example.`

If a recurring issue is solved by a specific fix, add to MEMORY.md:

`- <issue name>: <symptom>. Fix: <approach>. See file:line.`
```

## Skill preloading (`skills:`)

Frontmatter:

```yaml
skills:
  - api-conventions
  - error-handling-patterns
  - testing-style
```

Each listed skill's full body is injected into the agent's system context at startup. The agent sees the skill body as if it had been invoked, even though the agent did not call it.

Use cases:

- Domain conventions (`api-conventions` style guide injected so the agent follows them without re-discovering).
- Reusable workflows (a `commit-style` skill the agent treats as standing instructions).
- Reference knowledge (a `legacy-billing-context` skill that gives the agent background on a subsystem).

## Skill content lifecycle in agents

Per `tools/AgentTool/loadAgentsDir.ts` and the Anthropic docs:

- Skills are loaded at agent spawn time, not during work.
- The FULL skill body is injected, not just the description. This differs from the parent conversation, where the body loads only on invoke.
- Subagents do NOT inherit skills from the parent conversation. The agent must list every skill it needs explicitly.
- Skills with `disable-model-invocation: true` cannot be preloaded (security: those skills opted out of programmatic invocation).
- If a listed skill is missing or disabled, the loader logs a warning and skips it. The agent still spawns.

## What cannot be preloaded

- Skills with `disable-model-invocation: true`. The flag exists exactly to prevent programmatic invocation; preloading would bypass it.
- Skills that no longer exist (the file was removed). Logged as warning; agent spawns without it.
- Bundled CC skills (like `simplify`, `verify`, `init`). Preloading attempts log a warning; use the bundled invocation path instead.
- Cross-plugin skills outside the agent's scope. The loader resolves skill names against the active skill listing; cross-plugin references work if both plugins are enabled and the skill name resolves (use the namespaced form for plugin skills: `<plugin>:<skill-name>`).

## When to use memory vs skills vs both

| Need | Use |
|------|-----|
| Static domain knowledge the agent needs every run | `skills:` (preload at startup) |
| Knowledge the agent should accumulate over time | `memory:` (persistent dir) |
| Knowledge that differs across projects | `memory: project` (shared via git) or `memory: local` (private) |
| Knowledge that follows the user across projects | `memory: user` |
| Both static reference AND accumulated insights | Both fields. Skill provides the seed; memory adds project-specific learnings |

A code-reviewer agent often wants BOTH:

```yaml
---
name: code-reviewer
description: Reviews code for quality and security.
tools: Read, Grep, Glob, Bash
model: sonnet
memory: project
skills:
  - team-coding-conventions
  - security-checklist
---
```

The skills give the agent baseline conventions; the memory accumulates patterns and recurring issues specific to this codebase.

A simpler debugger usually just needs memory:

```yaml
---
name: debugger
description: Root-cause debugger.
tools: Read, Edit, Bash, Grep, Glob
memory: project
---
```

Some agents need neither:

```yaml
---
name: explorer
description: Fast read-only codebase exploration.
tools: Read, Grep, Glob
model: haiku
---
```
