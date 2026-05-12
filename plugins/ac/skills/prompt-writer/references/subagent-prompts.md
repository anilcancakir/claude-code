# Subagent Prompts

How to write the `prompt` field of an Agent tool call, brief a fresh subagent, or design a custom `subagent_type`. Read this when about to spawn an agent and need to write the briefing.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Anthropic Claude Code subagents page: https://docs.claude.com/en/docs/sub-agents.md
- Claude Code skills (for the `context: fork` pattern and skill-as-subagent): https://docs.claude.com/en/docs/skills.md
- Anthropic prompt engineering best practices: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
- Anthropic migration guide (4.7 subagent behavior changes): https://docs.claude.com/en/docs/about-claude/models/migration-guide.md

The guidance below mirrors the canonical "Writing the prompt" section embedded in Claude Code's live system prompt (the section the harness uses to brief the orchestrator when it considers spawning an Agent). When the live system prompt and this reference disagree, the live system prompt wins.

## The fundamental rule

A fresh subagent has zero context. It has not seen the conversation, does not know what has been tried, does not understand why this task matters. The prompt is its complete onboarding.

> "Brief the agent like a smart colleague who just walked into the room, it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters."

This is the canonical instruction the harness gives its orchestrator. Source: Anthropic Claude Code subagents page (https://docs.claude.com/en/docs/sub-agents.md) > Writing prompts for subagents.

Five things to include in every subagent brief:

1. **What you are accomplishing and why.** Goal first, then motivation.
2. **What you have already learned or ruled out.** Save the agent from redoing work.
3. **Enough surrounding context that the agent can make judgment calls.** Not just narrow instructions; the why behind them.
4. **Length cap if relevant.** "Report under 200 words" prevents an essay you do not need.
5. **The expected shape of the response.** "Return a punch list, done vs missing." Not "tell me what you found."

## Lookups vs investigations

The shape of the prompt depends on what kind of work is being delegated.

> "Lookups: hand over the exact command. Investigations: hand over the question, prescribed steps become dead weight when the premise is wrong."

Source: Anthropic Claude Code subagents page (https://docs.claude.com/en/docs/sub-agents.md).

**Lookups.** Hand over the exact command. No need for reasoning; the agent runs the command and reports.

```text
Run `git log --oneline main..HEAD` and return the list of commits with one-line summaries. Under 100 words.
```

**Investigations.** Hand over the question, not the steps. Prescribed steps become dead weight when the premise is wrong; the agent's job is to figure out the steps.

```text
Investigate why the test suite started failing on Tuesday. Look at the git log, the CI logs, and any recent dependency changes. Find the root cause and report what changed.
```

If you give an investigation prescribed steps, the agent will follow them even when they do not match reality. You waste a subagent run.

## Never delegate understanding

The most common subagent prompt failure: phrases that delegate synthesis you owe.

> "Never delegate understanding. Don't write 'based on your findings, fix the bug' or 'based on the research, implement it.' Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change."

Source: Anthropic Claude Code subagents page (https://docs.claude.com/en/docs/sub-agents.md) > Writing prompts for subagents.

**Anti-patterns and patterns.**

| Anti-pattern | Pattern |
|---|---|
| "Based on your findings, fix the auth bug." | "In `src/auth/middleware.ts:42`, the JWT verification skips the `nbf` claim. Add a check that rejects tokens whose `nbf` is in the future. Update the test in `src/auth/middleware.test.ts` to cover this case." |
| "Implement the feature based on the research." | "Add a `--dry-run` flag to `bin/migrate.ts`. When set, log every SQL statement without executing. Use the existing `Logger` interface in `src/logger.ts`. Tests go in `bin/migrate.test.ts`." |
| "Decide what makes sense and do it." | (Do not delegate. Decide yourself, then write a specific prompt.) |
| "Decide on the API shape and ship it." | "Define a POST `/api/users/{id}/avatar` endpoint that accepts multipart/form-data with a `file` field. Return 200 plus the new avatar URL on success, 415 if not an image, 413 if over 2MB. Use the existing `User` model and `S3Service`." |

## Terse command-style prompts produce shallow work

For fresh agents, terse command-style prompts produce shallow, generic work. Brief like a colleague who just walked in, not a typed search query. "Audit the codebase for unused imports" produces a generic walkthrough; the prompt below produces a usable report:

```text
Audit `packages/*/src/**/*.ts` for unused exports (exported symbols with zero imports across the monorepo). Use ts-prune or write your own check. Return a list of `file_path:line_number` entries grouped by package. Under 500 words. If you cannot find unused exports with confidence, say so and explain what tooling you tried.
```

## Length cap recommendations

Subagent reports come back into the orchestrator's context. A 2,000-word essay you only needed a punch list from is a token tax on the rest of the work. Cap explicitly.

| Type of work | Reasonable cap |
|---|---|
| Punch list / status check | "Under 200 words" |
| Investigation report | "Under 500 words. Lead with the root cause, then evidence." |
| Code review | "Under 1,000 words. One section per finding. Include `file_path:line_number` for each." |
| Deep research | "No cap, but lead with a 5-bullet executive summary." |

## When to spawn a subagent

Not every task warrants a subagent. Spawning has a cost: the agent must rebuild context, the prompt must be phrased carefully, and the result enters the orchestrator's context as opaque output.

**Spawn when:**

- Work fans out across many items or files (parallelizable, multiple subagents in one turn).
- The investigation will produce large output the orchestrator does not want in context.
- An independent second opinion is needed (the subagent did not see the orchestrator's reasoning, so its read is genuinely independent).
- A specialized agent matches the task description (use the right `subagent_type`).

**Do not spawn when:**

- Single function refactor the orchestrator can already see (just edit it).
- Lookup with a known exact command (just run the command).
- Sequential work that needs to maintain main-context state.
- The total cost of context-building plus run plus result-summarization exceeds doing it directly.

**Default behavior on Opus 4.7.** Spawns fewer subagents unprompted. If fan-out is needed, prompt for it explicitly. Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Subagent behavior.

## Foreground vs background

In Claude Code, an agent can run foreground (default) or background.

**Foreground.** Use when the agent's result is needed before the orchestrator can proceed. Research agents whose findings inform next steps. Code reviewers whose verdict gates the next commit.

**Background.** Use when there is genuinely independent work to do in parallel. Long-running builds, tests, data exports. The runtime notifies on completion. Do not poll, do not sleep, do not check progress proactively.

**Anti-pattern.** Spawning multiple foreground agents serially when they could run in parallel. If three agents are independent, send all three in one message with three Agent tool calls.

Source: https://docs.claude.com/en/docs/sub-agents.md > Spawning agents (foreground vs background section).

## Forking variant (no `subagent_type`)

When the orchestrator calls Agent without specifying `subagent_type`, CC may create a fork: a background subagent that runs concurrently in an isolated context. The harness's forking-variant prompt says:

> "Calling Agent without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context, so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. If you ARE the fork, execute directly; do not re-delegate."

The "if you are the fork, do not re-delegate" line is important: a fork that calls Agent again spawns a sub-fork, multiplying context cost. Stay direct.

Source: https://docs.claude.com/en/docs/sub-agents.md > Forking subagent context (or the most current section name; the forking variant is gated by a feature flag in the harness).

## Worked examples (canonical patterns)

The two canonical patterns the harness teaches its orchestrator. Copy these shapes when in doubt.

### Example 1: branch ship-readiness audit (lookup-shaped)

User: "What's left on this branch before we can ship?"

```text
Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list, done vs missing. Under 200 words.
```

Why this works: the prompt is self-contained: it states the goal, lists what to check, and caps the response length. The agent's report comes back as the tool result; the orchestrator relays the findings to the user.

### Example 2: independent migration review (investigation-shaped)

User: "Can you get a second opinion on whether this migration is safe?"

```text
Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes, I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?
```

Why this works: the agent starts with no context from this conversation, so the prompt briefs it: what to assess, the relevant background, and what form the answer should take.

Source: these two examples are the canonical "Example usage" block embedded in Claude Code's live system prompt under "Writing the prompt", mirrored in the subagents docs at https://docs.claude.com/en/docs/sub-agents.md.

## Parallel fan-out pattern

When fanning out across files or domains, send multiple Agent calls in one assistant message:

```
Agent({description: "Audit auth module", prompt: "Read src/auth/**/*.ts. Report any places where JWT validation skips the `nbf`, `exp`, or `aud` claims. Cite file_path:line_number for each finding. Under 300 words."})

Agent({description: "Audit middleware module", prompt: "Read src/middleware/**/*.ts. Report any places where errors are swallowed (try/catch with empty catch, or catch that logs but does not re-throw or return). Cite file_path:line_number. Under 300 words."})

Agent({description: "Audit DB module", prompt: "Read src/db/**/*.ts. Report any raw SQL strings that interpolate user input without parameterization. Cite file_path:line_number. Under 300 words."})
```

Three independent reads, one orchestrator turn, three parallel runs.

## Fresh general-purpose agent

When delegating to the bundled `general-purpose` subagent (a built-in Claude Code subagent for researching complex questions, searching for code, and executing multi-step tasks), match the shape its system prompt expects.

The bundled body sets these expectations (paraphrased from the harness's behavior, documented in https://docs.claude.com/en/docs/sub-agents.md):

- Concise report covering what was done and key findings; the caller will relay it.
- Do not gold-plate, but do not leave the task half-done.
- Search broadly when the file is unknown; Read when the path is known.
- Start broad, narrow down. Use multiple search strategies if the first does not yield results.
- Do not create files unless absolutely necessary. Prefer editing an existing file.
- Do not proactively create documentation files (`*.md`).

Briefings that fight these defaults waste turns. Match the agent's shape.

```text
Find unused exports in `packages/*/src/**/*.ts`. Project is a TypeScript monorepo. "Unused" means zero imports across the monorepo. Use ts-prune or your own grep-based check. Return a list of `file_path:line_number` entries grouped by package. Under 500 words. If you cannot find unused exports with confidence, say so and explain what tooling you tried.
```

## Verification

After a subagent returns, do not blindly trust the summary. The summary describes what the agent intended to do, not necessarily what it did.

**Verification rules.**

- If the agent wrote or edited code, read the diff before reporting work as done.
- If the agent ran a command, check the actual output, not just the agent's summary.
- If the agent did research, spot-check at least one citation.

This is doubly important for `subagent_type` agents that bypass the orchestrator's tool oversight.

## Resuming an agent

To continue a previously spawned agent with full context, use SendMessage with the agent's ID or name as the `to` field. A fresh Agent call starts a new agent with no memory.

**Pattern.** Spawn an agent for an investigation, then SendMessage to ask follow-up questions, rather than spawning a new agent each time.

## `subagent_type` design (pushy descriptions)

When defining a custom `subagent_type` in `.claude/agents/<name>.md`, the `description` field is the primary triggering mechanism. From https://docs.claude.com/en/docs/skills.md > Skill not triggering troubleshooting: check the description includes keywords users would naturally say.

**Pushy description pattern.**

```markdown
description: Use when the user mentions [trigger 1, trigger 2, trigger 3]. Triggers on [common phrasings]. Use this agent aggressively; undertriggering is the failure mode. Do not skip in favor of [common alternative] when [specific condition].
```

The orchestrator decides whether to delegate based on the description. A vague description ("a helpful agent for code review") undertriggers. A pushy description ("use whenever the user mentions code, PRs, diffs, reviews, or audits, even if they do not say 'review'") triggers reliably.

## Quick checklist for subagent prompts

- [ ] States goal and motivation.
- [ ] Includes context the agent needs (what was learned, ruled out, assumed).
- [ ] Includes specifics (file paths, line numbers, exact commands when applicable).
- [ ] Does not say "based on your findings" or "decide what makes sense".
- [ ] Caps length explicitly.
- [ ] Defines the output shape.
- [ ] Right shape for the work (lookup gets a command; investigation gets a question).
- [ ] Independent agents in the same turn use parallel Agent calls.
- [ ] Foreground/background choice is intentional.
- [ ] After return: verify the diff or output, do not trust the summary blindly.
