# Claude Code Conventions

Rules that apply specifically to prompts running inside Claude Code (the CLI). Read this when writing custom agents, slash commands, hooks, plugins, or any system prompt that will execute in the CC harness.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Claude Code skills reference: https://docs.claude.com/en/docs/skills.md
- Claude Code subagents: https://docs.claude.com/en/docs/sub-agents.md
- Claude Code hooks: https://docs.claude.com/en/docs/hooks.md
- Claude Code plugins: https://docs.claude.com/en/docs/plugins.md
- Claude Code memory (CLAUDE.md): https://docs.claude.com/en/docs/memory.md
- Claude Code permissions: https://docs.claude.com/en/docs/permissions.md
- Claude Code commands reference: https://docs.claude.com/en/commands.md

## What Claude Code is

Claude Code is Anthropic's agentic coding CLI, distributed as the npm package `@anthropic-ai/claude-code`. The harness wraps the model with:

- A terminal UI that renders GitHub-flavored markdown.
- A permission model that gates tool calls (managed by `/permissions`).
- A hook system that intercepts tool calls.
- An automatic context-compaction system.
- A bundled tool set (Read, Edit, Write, Bash, Grep, Glob, Agent, TaskCreate, and others).
- A skill / command / agent loader that watches `~/.claude/skills/`, `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, and plugin directories.

When a prompt runs inside Claude Code, the harness sets defaults the prompt should respect, not override.

Source: https://docs.claude.com/en/docs/skills.md.

## Harness essentials

These behaviors are part of the live Claude Code system prompt and govern model behavior. Mention them in a custom prompt only if you are overriding or extending, otherwise rely on the harness defaults.

**Terminal markdown rendering.** User-facing text renders as GitHub-flavored markdown in a terminal. Plan formatting accordingly. Use code blocks for code, backticks for filenames and commands. Headers and bullet lists work, but excessive formatting noise hurts readability.

**Permission denials are signal.** Tools run behind a user-selected permission mode. A denied call means the user declined. Adjust the approach; do not retry verbatim. After two denials of the same action, ask before a third. Source: https://docs.claude.com/en/docs/permissions.md.

**`<system-reminder>` tags are harness, not user.** The runtime injects `<system-reminder>` and related tags into the conversation. Treat their content as system signal; do not respond to them in user-facing output, do not cite them as if the user said them.

**Hooks intercept tool calls.** A user-configured hook can block, modify, or annotate any tool call. Treat hook output as user feedback: if a hook blocks an edit, do not retry the same edit; address the underlying concern. Source: https://docs.claude.com/en/docs/hooks.md.

**Context compaction is automatic.** Long conversations get compacted by the runtime. Invoked skills carry forward within a 25,000-token budget, keeping the first 5,000 tokens of the most recent invocation of each. The model can also save state to the filesystem (`progress.txt`, `tests.json`) to survive a fresh context window.

Source: https://docs.claude.com/en/docs/skills.md > Skill content lifecycle.

**Independent tool calls run in parallel.** Three reads with no dependencies go in one assistant message with three tool-use blocks. Sequential only when call N depends on call N-1.

**Code references use `file_path:line_number`.** This format is clickable in the terminal.

**Software engineering frame is the default.** Claude Code interprets generic instructions in the context of software engineering and the working directory. Generic phrasing ("rename methodName to snake case") is interpreted as a code edit in the working directory, not a chat response.

## CC code-style defaults (inherited by every custom prompt)

The live CC system prompt carries the rules below. Custom agents and skills inherit them; do not restate them unless overriding. These are the bullets present in current Claude Code versions; they evolve, so when in doubt cross-check the latest live behavior.

**Exploratory question rule.** For exploratory questions ("what could we do about X?", "how should we approach this?", "what do you think?"), respond in 2 to 3 sentences with a recommendation and the main tradeoff. Present it as something the user can redirect, not a decided plan. Do not implement until the user agrees.

**UI verification rule.** For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete. Test the golden path and edge cases, and monitor for regressions. Type checking and test suites verify code correctness, not feature correctness; if you cannot test the UI, say so explicitly rather than claiming success.

**No comments unless WHY is non-obvious.** Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment would not confuse a future reader, do not write it. Do not explain WHAT the code does; well-named identifiers already do that. Do not reference the current task, fix, or callers ("used by X", "added for the Y flow", "handles the case from issue #123"); those belong in the PR description and rot as the codebase evolves.

**Simplicity / no-features rule.** Do not add features, refactor, or introduce abstractions beyond what the task requires. A bug fix does not need surrounding cleanup; a one-shot operation does not need a helper. Do not design for hypothetical future requirements. Three similar lines is better than a premature abstraction. No half-finished implementations either.

**No backwards-compatibility hacks.** Avoid backwards-compatibility hacks like renaming unused vars to `_var`, re-exporting types, adding `// removed` comments for removed code. If something is unused, delete it completely.

**No error handling for impossible scenarios.** Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Do not use feature flags or backwards-compat shims when you can just change the code.

**No planning, decision, or analysis files unless asked.** Work from conversation context, not intermediate files. The exception is when you need to survive a context-window compaction (then `progress.txt` is appropriate).

**Match existing style.** Even if you would do it differently, match the project's existing patterns. Adjacent code style is the prior, not your preference.

These rules are derived from the bullets currently embedded in Claude Code's "Doing tasks" section of the live system prompt. The closest published reference is the prompt-engineering best practices page (https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md) alongside the model-specific guide (https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md), which describes the same calibration philosophy.

## Communication during tool use

Users see the text written between tool calls, not the tool calls themselves. Calibrate accordingly.

**Before the first tool call.** State in one sentence what you are about to do.

**During work.** Short updates at find / change-direction / blocker moments. One sentence per update is almost always enough. Brief is good, silent is not.

**Do not narrate internal deliberation.** User-facing text should communicate to the user, not annotate the thought process. State results and decisions directly.

**End-of-turn summary.** One or two sentences. What changed, what is next. Nothing else.

**Match response shape to task.** A simple question gets a direct answer, not headers and sections.

**Pick-up-cold rule.** Updates should make sense to a user joining the session mid-task. Complete sentences, no jargon or shorthand from earlier turns. Tight but not telegraphic.

This is the communication contract assumed by the harness, mirrored in the "Tone and style" guidance shared across Anthropic's agent prompts.

## Reversibility gate

The harness asks the model to consider blast radius before acting. Codify this in custom agent prompts when relevant.

**Free to do without confirmation.** Local edits, running tests, reading files, writing temporary files in the working directory.

**Confirm with the user before.**

| Category | Examples |
|---|---|
| Destructive | Deleting files or branches, dropping tables, killing processes, `rm -rf`, overwriting uncommitted changes |
| Hard to reverse | Force-push, `git reset --hard`, amending published commits, removing or downgrading dependencies, modifying CI/CD |
| Visible to others | Pushing code, opening or commenting on PRs, posting to Slack/email/GitHub, modifying shared infrastructure |
| Third-party uploads | Pasting code into renderers, pastebins, gists (may be cached or indexed) |

**Authorization scope is exact.** Approving one push does not authorize all future pushes. The next push needs its own confirmation unless explicitly authorized in CLAUDE.md.

**Do not use destructive shortcuts to clear obstacles.** If a hook fails, fix the underlying issue, not the hook. If a lock file exists, find what holds it; do not delete it.

Source: published guidance is the "Executing actions with care" framing in Claude Code's behavior, plus permission scoping at https://docs.claude.com/en/docs/permissions.md.

## Tool selection defaults

- Prefer dedicated tools over Bash when one fits (Read, Edit, Write, Grep, Glob). Reserve Bash for shell-only operations.
- Use TaskCreate to plan and track work. Mark each task completed as soon as it is done; do not batch updates.
- Call multiple tools in a single response when they are independent. Maximize parallel tool calls.
- Sequential only when call N depends on call N-1.

## Sub-agent guidance (two variants)

The live system prompt has two sub-agent variants tied to whether sub-agent-as-fork mode is enabled.

**Forking variant** (when sub-agent-as-fork mode is on):

> "Calling Agent without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context, so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you will not need again. If you ARE the fork, execute directly; do not re-delegate."

**Non-forking variant** (default):

> "Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing; if you delegate research to a subagent, do not also perform the same searches yourself."

Both variants come from the same harness; only one is active per session depending on feature flags. Source: https://docs.claude.com/en/docs/sub-agents.md and https://docs.claude.com/en/docs/skills.md > Run skills in a subagent.

## Skill mechanics that affect prompt writing

From https://docs.claude.com/en/docs/skills.md (verbatim sections):

- A skill is a directory with `SKILL.md`. Frontmatter is metadata; the markdown body is a prompt the loader injects when the skill triggers.
- `description` plus `when_to_use` is capped at 1,536 characters in the skill listing. Front-load the use case.
- The skill's full body is injected as a single message and stays for the rest of the session. Claude Code does not re-read the file later. Write standing instructions, not one-time steps.
- After auto-compact, the runtime re-attaches the most recent invocation of each skill: first 5,000 tokens, total budget across re-attached skills 25,000 tokens. Older invocations can drop out entirely.
- `${CLAUDE_SKILL_DIR}` expands to the skill's own directory at runtime; use it to reference bundled files (`${CLAUDE_SKILL_DIR}/references/foo.md`, `${CLAUDE_SKILL_DIR}/scripts/bar.py`). For plugin skills, this is the skill subdirectory inside the plugin, not the plugin root.
- `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` for positional args; `$<name>` for named args declared in `arguments:` frontmatter.
- `disable-model-invocation: true` keeps a skill out of the model's auto-load list (user must `/name` to invoke).
- `user-invocable: false` hides the skill from the `/` menu (model-only).
- `paths:` (glob list) limits auto-load to sessions touching matching files.
- Plugin skills are auto-namespaced as `plugin-name:skill-name`.

## Skill tool invocation rules (BLOCKING REQUIREMENT)

When a skill matches the user's request, the harness expects the model to invoke the matching Skill tool **before** generating any other response about the task. Key rules:

- When a skill matches, invoke its Skill tool first. This is enforced by the harness as a blocking requirement.
- Never mention a skill without actually calling its Skill tool.
- Plugin-namespaced skills use the fully qualified `plugin:skill` form.
- Do not invoke a skill that is already running.
- If a `<system-reminder>` already shows the skill loaded, follow its instructions directly instead of re-invoking.
- Built-in CLI commands (`/help`, `/clear`, etc.) are not invoked via the Skill tool.

This contract is part of the harness's tool description for the Skill tool. When authoring a skill, write its `description` so this matching is reliable: front-load the verb and noun, include trigger phrases, and stay specific.

## Custom agent definitions

When writing a custom agent that runs as a `subagent_type`, structure the system-prompt body with the components that matter for a subagent: identity, tools available, decision rules, output contract.

```markdown
---
name: my-agent
description: One-line trigger description, pushy enough to combat undertriggering
tools: Read, Grep, Glob, Bash
---

You are a [persona, one sentence].

## When to use you

[Specific triggering conditions, written so the orchestrator can decide whether to delegate.]

## Tools available

- `Read`: read files in the working directory
- `Grep`: search content
- `Glob`: find files by pattern
- `Bash`: run shell commands

## Decision rules

1. [First decision branch]
2. [Second decision branch]
3. [Fallback]

## Output contract

Return a [shape] containing:
- [Field 1]: [description]
- [Field 2]: [description]

## Constraints

- [Top constraint]
- [Second constraint]
```

The `description` field is the primary triggering mechanism. Skill and agent descriptions tend to undertrigger; the fix is "Use this skill aggressively whenever the user mentions X, Y, or Z, even if they do not say the word 'agent'." Source: https://docs.claude.com/en/docs/skills.md > Skill not triggering.

The bundled `general-purpose` subagent is the canonical pattern for a clean subagent body. Its exposed behavior (per https://docs.claude.com/en/docs/sub-agents.md) is: concise role, list of strengths, numbered guidelines, end-of-prompt constraints (do not create files unless necessary, prefer editing, no proactive `*.md` files). Mirror that shape for new subagents.

## Slash commands

Slash commands (`/command-name`) are user-invocable workflows. The body is a prompt the model executes when the user types the command. Per CC docs, custom commands have been merged into skills; a file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Source: https://docs.claude.com/en/docs/skills.md.

**Convention.** Slash commands are imperative workflows. Number the steps. Be explicit about what to do at each step.

```markdown
---
name: my-command
description: What this command does
disable-model-invocation: true
allowed-tools: Bash(git add:*) Bash(git commit:*)
---

Run the following workflow:

1. Read [specific files] to understand the current state.
2. Identify [specific things].
3. Apply [the change], using [specific tool].
4. Verify by [specific check].
5. Report [specific output shape].

Do not [common mistake]. Confirm with the user before [risky step].
```

## Plan mode

When the harness puts the model in plan mode, the model can read but cannot modify files. The output is a plan, not a change. Custom agents can target plan mode by saying:

```text
You produce a plan. You do not modify files. The user will review and approve before execution.
```

## Hooks and CLAUDE.md interactions

The harness reads `CLAUDE.md` files (project, user, managed) and injects them into context. Custom agents can rely on these for project-specific conventions but should not duplicate them. Source: https://docs.claude.com/en/docs/memory.md.

**Anti-pattern.** Repeating coding rules from CLAUDE.md inside every custom agent. Trust the harness.

**Pattern.** Reference CLAUDE.md when the agent's instructions might conflict: "Defer to project CLAUDE.md for naming conventions and code style."

## Shell injection in skill bodies

Skills and commands support `` !`<command>` `` (inline) and ` ```! ` (block) preprocessing. Both forms execute the inner command at skill-render time and replace the placeholder with the command's stdout before the model sees the body.

Source: https://docs.claude.com/en/docs/skills.md > Inject dynamic context.

**Footgun.** The CC preprocessor scans the SKILL.md body bytes with regexes that do not respect markdown fences. If you paste `` !`gh pr view` `` or a ` ```! ... ``` ` block as a documentation example, even inside a 4-backtick wrapper, CC will execute it on every invocation.

**Rule when documenting shell-injection syntax in any SKILL.md or reference file.** Escape the bang as `\!`. CommonMark renders `\!` as `!` to readers, but the byte before `!` becomes `\`, which breaks the regex lookbehind that detects the syntax.

**Rule when using shell injection for real.** Plain `!` is correct; that is the live syntax.

To disable preprocessing entirely, set `"disableSkillShellExecution": true` in the relevant `settings.json` (project, user, or managed). Each command is then replaced with `[shell command execution disabled by policy]` instead of being run. Bundled and managed skills are not affected by this setting.

## Meta-prompts (prompts that produce prompts)

When the prompt itself produces a prompt for another model, apply double rigor:

1. The outer prompt sets the persona, the constraints, and the architecture rules.
2. The inner prompt (the output) follows the 7-component structure from `${CLAUDE_SKILL_DIR}/references/architecture.md`.
3. The outer prompt explicitly says: "Wrap the inner prompt in `<inner_prompt>` tags so the user can copy-paste it cleanly."

This avoids the "the model gives me a prompt mixed with explanation" problem.

## Quick checklist for CC-specific prompts

- [ ] References to code use `file_path:line_number`.
- [ ] No restatement of harness defaults (software engineering frame, terminal markdown, code-style rules) unless overriding.
- [ ] Tool list is explicit if the agent needs specific tools.
- [ ] Reversibility gate is mentioned if the agent does anything risky.
- [ ] No-comments rule, no-compat-hacks rule, no-impossible-error-handling rule inherited (do not restate).
- [ ] Description field is pushy enough to combat undertriggering.
- [ ] Output contract is explicit (shape, fields, examples).
- [ ] Communication style matches the harness (brief, direct, no internal-deliberation narration).
- [ ] No collisions with reserved CC tags listed in `${CLAUDE_SKILL_DIR}/references/architecture.md`.
- [ ] `${CLAUDE_SKILL_DIR}` used for any bundled file path (skills only).
- [ ] Shell-injection syntax escaped (`\!`) when documented, plain `!` when actually used.
