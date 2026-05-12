# Agent Anti-Patterns

Common agent-authoring mistakes specific to agents (above and beyond the general skill anti-patterns in `ac:skill-creator`'s `anti-patterns.md`). Read this when auditing or debugging a custom subagent.

## Contents

- Frontmatter failures
- Tool restriction failures
- Body content failures
- Memory and skill failures
- Plugin-agent failures
- Invocation failures
- Audit checklist

## Frontmatter failures

### Vague `description`

**Mistake**: `description: Helps with code stuff`.

**Symptom**: The orchestrator never delegates to the agent. The agent stays cold while the model uses generic tools.

**Fix**: Third-person specific description with trigger phrases. "Reviews recently modified code for security, quality, and maintainability. Use proactively after writing or modifying code."

### First-person `description`

**Mistake**: `description: I review code for security`.

**Symptom**: The orchestrator's listing reads mixed POV ("I" / "you" mixing); delegation gets confused.

**Fix**: Third person. "Reviews code for security."

### `name` not matching the filename

**Mistake**: file is `code-review.md`, frontmatter has `name: reviewer`.

**Symptom**: Filename or `name` mismatch; the orchestrator may use one to spawn while the other appears in listings. Confusing.

**Fix**: Either omit `name` (fall back to filename without `.md`) or set it to match. Diverging on purpose is rare.

### Aggressive caps in `description`

**Mistake**: `description: CRITICAL: ALWAYS use this agent for ALL code review tasks.`

**Symptom**: The orchestrator overtriggers; the agent fires for trivial reviews where the work could have stayed inline.

**Fix**: Plain language. "Use proactively after writing or modifying code." Modern Claude reads aggressive caps literally and shifts trigger probability up.

### `tools: []` (empty list)

**Mistake**: Empty tool allowlist.

**Symptom**: The agent has no tools and returns empty work.

**Fix**: Either omit `tools:` to inherit, or list the tools the body actually uses.

### Setting `permissionMode`, `hooks`, or `mcpServers` in a plugin agent

**Mistake**: Plugin agent file declares `permissionMode: bypassPermissions`.

**Symptom**: Silently ignored. The agent runs under the parent's permission mode. Logged as a debug warning, but the user never sees it unless they check logs.

**Fix**: Move the agent to `.claude/agents/` (project) or `~/.claude/agents/` (user). Plugin agents lose these fields by design (security boundary in `loadPluginAgents.ts:161-168`).

## Tool restriction failures

### Bare `tools: Bash`

**Mistake**: Pre-approves every shell command.

**Symptom**: The agent can run `rm -rf` without prompting under any permission mode short of explicit deny.

**Fix**: Narrow patterns. `Bash(git:*)`, `Bash(gh:*)`, `Bash(npm test:*)`. List the exact subcommands the body uses.

### Body says "edit the file" but `disallowedTools: Edit, Write`

**Mistake**: Body and frontmatter contradict.

**Symptom**: The agent attempts Edit, fails, returns confused work.

**Fix**: Pick one. If the agent should modify files, allow Edit/Write. If it should only suggest, rewrite the body to "report what should change" and keep Edit/Write denied.

### Missing tools the body uses

**Mistake**: `tools: Read, Grep` but the body says "run git status".

**Symptom**: Bash call fails fast at runtime.

**Fix**: Read the body line by line, list every tool the steps invoke.

### `Agent` in a subagent's `tools`

**Mistake**: Subagent's frontmatter has `tools: Agent, Read, Bash`.

**Symptom**: No effect. Subagents cannot spawn other subagents (the Agent tool is unavailable in subagent contexts).

**Fix**: Remove `Agent` from `tools`. The field is only meaningful for agents that run as the main thread via `claude --agent <name>`.

### Bash allowed but no PreToolUse validation

**Mistake**: `tools: Bash` for an agent that should be read-only on the database.

**Symptom**: The agent can run any SQL including writes and DROPs.

**Fix**: Add a `PreToolUse` hook (non-plugin agent) that reads the JSON input, checks the command pattern, exits 2 to block writes. See `references/tool-restrictions.md` for the validation script template.

## Body content failures

### No five-section pattern, no clear Output Format

**Mistake**: Body is a prose paragraph saying "review the code thoroughly".

**Symptom**: Each invocation returns a different shape. The orchestrator cannot reliably parse the result.

**Fix**: Adopt the five-section pattern (Identity / Execution / Output Format / Failure Conditions / Constraints). Lock the Output Format with verbatim headers.

### "Based on your findings, do X" inside the body

**Mistake**: Body ends with "Based on your research, fix the bug."

**Symptom**: The agent has less context than the parent. "Based on your findings" pushes synthesis the parent should have done onto an agent that cannot make those judgment calls.

**Fix**: Either specify the work (file paths, line numbers, exact change) or do not delegate. Forked agents with vague tasks return shallow generic work.

### Body documents the Agent-tool interface

**Mistake**: Body says "When called via the Agent tool, you receive..."

**Symptom**: Wastes tokens on metadata the model does not need.

**Fix**: The orchestrator handles spawning. The agent's body never describes how it is called; it describes what it does.

### Body duplicates CLAUDE.md

**Mistake**: Body repeats coding conventions, repo structure, test commands.

**Symptom**: Token bloat. Agent already auto-loads CLAUDE.md (unless `omitClaudeMd` is set, which is built-in only).

**Fix**: Trust CLAUDE.md. The body only adds what is specific to THIS agent's role, not the codebase.

### Aggressive caps everywhere

**Mistake**: Body is full of "CRITICAL", "MUST NEVER", "ALWAYS", "STRICTLY PROHIBITED".

**Symptom**: Modern Claude reads caps literally. The agent becomes brittle, refusing edge cases that should pass.

**Fix**: Reserve caps for truly safety-critical lines (irreversible writes, security-sensitive paths). Explain the why instead of shouting. Built-in Explore and Plan use caps for "READ-ONLY" enforcement; that is a legitimate use because the agent must not write under any circumstance.

### No "Failure Conditions" section

**Mistake**: Body has Identity, Execution, Output Format, then ends.

**Symptom**: Agent has no self-check; returns plausible-looking work that misses obvious failures.

**Fix**: Add Failure Conditions. "FAILED if: <quality-gate violations>." The agent reads these before returning.

## Memory and skill failures

### `memory: project` but body never mentions memory

**Mistake**: Frontmatter has `memory: project` but the body has no instructions to read or update MEMORY.md.

**Symptom**: Memory directory is created but the agent never accumulates knowledge.

**Fix**: Body must explicitly instruct the agent to read MEMORY.md (which is in its system prompt automatically) and append updates after the task.

### MEMORY.md exceeds the cap

**Mistake**: Agent appends every observation to MEMORY.md; file grows past 200 lines.

**Symptom**: The loader truncates at 200 lines (or 25 KB). The agent loses access to entries past the cap.

**Fix**: Body should instruct the agent to keep MEMORY.md as a summary index and overflow detail to sub-files in the memory directory.

### Preloading a `disable-model-invocation: true` skill

**Mistake**: `skills: [my-deploy-skill]` where the deploy skill has `disable-model-invocation: true`.

**Symptom**: The loader skips the skill with a warning. Agent spawns without the expected context.

**Fix**: Either drop the `disable-model-invocation` flag from the skill (if safe), or do not preload it; the user invokes it manually instead.

### Preloading skills that do not exist

**Mistake**: `skills: [missing-skill]`.

**Symptom**: Logged as warning, agent spawns without the skill. Body assumes the skill content is present and fails.

**Fix**: Verify each listed skill name resolves to a real skill in the active scope before shipping.

### Subagent expects to inherit parent skills

**Mistake**: Parent conversation invoked `/api-conventions`; agent body assumes those conventions are loaded.

**Symptom**: Subagents do NOT inherit skills from the parent. The agent runs without the conventions.

**Fix**: Either preload via `skills:` field, or include the convention content in the body, or ship as a skill the agent invokes itself.

## Plugin-agent failures

### `${CLAUDE_PLUGIN_ROOT}` in a non-plugin agent

**Mistake**: User agent at `~/.claude/agents/foo.md` has `Read ${CLAUDE_PLUGIN_ROOT}/templates/x.md`.

**Symptom**: Literal `${CLAUDE_PLUGIN_ROOT}` appears in the rendered prompt. Substitution only happens for plugin agents.

**Fix**: For non-plugin agents, embed the content in the body, or use an absolute path, or convert to a skill that the agent invokes.

### Documenting `${CLAUDE_PLUGIN_ROOT}` literally in a plugin agent body

**Mistake**: Plugin agent body has documentation text like "the `${CLAUDE_PLUGIN_ROOT}` path resolves to the plugin root".

**Symptom**: On every spawn, the loader substitutes `${CLAUDE_PLUGIN_ROOT}` to the actual path; the documentation reads "the `/path/to/plugin` path resolves to the plugin root", which is tautological.

**Fix**: For plugin agent bodies, do not document the placeholder name. Just use it as a path. If you must document it, write it without the dollar prefix or use prose ("the plugin root token").

### Plugin agent expects `permissionMode`, `hooks`, or `mcpServers` to apply

**Mistake**: Plugin agent has `hooks: ...` to validate Bash calls.

**Symptom**: Silently ignored at load time. Validation never runs.

**Fix**: If conditional validation is necessary, the agent cannot ship via a plugin. Move to a user or project agent.

## Invocation failures

### Subagent tries to spawn another subagent

**Mistake**: Body says "use the Agent tool to delegate to the worker subagent".

**Symptom**: Agent tool unavailable in subagent context. The call fails.

**Fix**: Subagents cannot spawn. Restructure: parent orchestrates, agents return their results to the parent, parent decides next delegation.

### Agent runs forever, no `maxTurns`

**Mistake**: Long-running research agent has no `maxTurns` cap.

**Symptom**: Agent loops on a tricky case for many turns, burning tokens.

**Fix**: Set `maxTurns: 20` (or appropriate cap). Agent stops; parent sees the partial result and can decide whether to re-spawn with refined input.

### Agent prompts user repeatedly during run

**Mistake**: Agent fires `Bash(npm install)` etc. without `permissionMode` set, and the user has not pre-approved these tools.

**Symptom**: User gets prompted mid-agent-run for each call. Annoying and breaks any automation pipeline.

**Fix**: Either narrow `tools` to subcommands the user pre-approved, or set `permissionMode: acceptEdits` (non-plugin only) for trusted edit operations, or pre-approve at the parent session level.

### Background agent gets stuck on a missing permission

**Mistake**: Spawned with `run_in_background: true`, but the agent needs a tool that was not pre-approved.

**Symptom**: Background agents auto-DENY anything not pre-approved at launch; the agent fails silently.

**Fix**: Spawn foreground for the first run (sees what gets prompted), pre-approve those tools, then background subsequent runs. Or list every needed tool in `tools` so the user pre-approves at launch.

## Audit checklist

When auditing an existing agent, walk these:

- [ ] `name` is lowercase + hyphens, matches the filename.
- [ ] `description` is third-person, names trigger conditions, covers synonyms.
- [ ] No aggressive caps in `description` (one or two "use proactively" hints is fine; "CRITICAL" / "ALWAYS" is too much).
- [ ] `tools` or `disallowedTools` matches what the body actually uses.
- [ ] No bare `Bash` unless validated by a `PreToolUse` hook.
- [ ] `Agent` in `tools` only for main-thread agents.
- [ ] `model` and `effort` match the agent's complexity tier.
- [ ] If plugin agent: no `permissionMode`, `hooks`, or `mcpServers` (would be ignored).
- [ ] If `memory:` set: body instructs the agent to read and update memory.
- [ ] If `skills:` set: every listed skill resolves and has `disable-model-invocation: false`.
- [ ] Body follows the five-section pattern (or has explicit reason to skip).
- [ ] Output Format is locked verbatim.
- [ ] Failure Conditions section exists and lists observable gates.
- [ ] No "based on your findings, do X" delegation patterns.
- [ ] No duplicated CLAUDE.md content.
- [ ] Body uses second person, imperative voice in Execution.
- [ ] Body passes `ac:prompt-writer` audit (no aggressive caps unless safety-critical, positive instructions, why explained).
- [ ] Test spawn in a fresh session: orchestrator delegates appropriately, agent returns the locked shape.
