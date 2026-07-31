# Opus 5 Tuning for Skill Bodies

Skill-specific tuning for the current Claude family. Default target is Opus 5 (`claude-opus-5`, released 2026-07-24). Sonnet 5 (`claude-sonnet-5`) follows the same patterns; Haiku 4.5 (`claude-haiku-4-5-20251001`) differs on effort and thinking. This reference focuses on the knobs that matter when authoring the body of a skill; for prompt-architecture tuning beyond skills, route through `ac:prompt-writer` and read its `references/opus-5-tuning.md`.

4.8 to 5 is a tuning step for skill bodies, not a port: there are no API changes a skill body touches, and a body that ran on Opus 4.8 runs on Opus 5. But two model defaults inverted, so two specific 4.8-era body patterns now push in the wrong direction. Those two are first below.

## Contents

- The two inversions that change skill bodies
- Effort and the `effort:` frontmatter field
- Verbosity and output length
- Task scope and over-verification
- Subagent spawning (and `context: fork`)
- Thinking, `ultrathink` keyword, adaptive thinking
- Model overrides, when to set `model:`
- Verbosity-sensitive output shapes
- User-facing progress updates
- Long-horizon skills (compact-survival)
- Frontend and visual output
- Sonnet 5 quick deltas
- Haiku 4.5 quick deltas

## The two inversions that change skill bodies

| Behavior | Opus 4.8 | Opus 5 | Body-level consequence |
|---|---|---|---|
| Verbosity | Self-calibrates to task complexity | Runs longer by default, and effort does not reliably shorten it | A body that relied on self-calibration now needs an explicit length target. Lowering `effort:` will not fix long output. |
| Subagent spawning | Spawns fewer unprompted | Delegates more readily | A body carrying "spawn multiple subagents when fanning out" now overtriggers delegation. Invert it to say when NOT to spawn. |

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Response length and verbosity, Controlling subagent spawning.

## Effort and the `effort:` frontmatter field

| Effort | Use for | Notes |
|--------|---------|-------|
| `xhigh` | Coding and agentic work, the default for skill execution | Set this for any skill that touches code, runs migrations, edits configs, or chains tool calls |
| `high` | Intelligence-sensitive non-coding tasks | The model default and the floor for tasks where intelligence matters; audits, reviews, deep research |
| `medium` | Cost or latency-sensitive tasks where intelligence still matters | Shorter reports, summarization |
| `low` | Short scoped tasks | Quick formatters, lookups |
| `max` | Hardest problems | Diminishing returns past `xhigh`; can overthink |

Opus 5 converts additional effort into better results more reliably than any earlier Opus model, so raising effort is a stronger lever than it was on 4.8. If you see shallow reasoning, raise `effort:` to `high` or `xhigh` instead of papering over with prompt instructions.

What effort no longer does: shorten output. On 4.8, dropping to `low` or `medium` scoped the work down and shortened responses as a side effect. On Opus 5, changing effort does not reliably shorten responses. Length is a body-level instruction now, not an effort setting.

Set `effort:` only when the skill needs a different reasoning budget than the session default. Most skills inherit fine. A complex audit skill at `effort: high`, a quick formatter skill at `effort: low`. Anything outside that range usually means the skill is doing too much; split it.

Do not set `effort:` on a skill you expect to run under Haiku 4.5; that model does not support the parameter at all.

Source: https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md > Effort matters more, and https://platform.claude.com/docs/en/build-with-claude/effort.md.

## Verbosity and output length

Opus 5 produces longer default responses than prior Opus models. Old hedges still hurt, but the fix is now load-bearing rather than optional:

- Drop "be concise", "do not be verbose", "avoid long responses". These are negative-only and force the model to imagine the wrong behavior first.
- State the length positively, with a target. "Provide concise, focused responses. Lead with the answer, then add at most three supporting sentences."
- For reports, state the shape and a soft length cap. "Under 800 words. Lead with the feature's purpose in one sentence."
- Separate the deliverable's length from the conversation's length. A body that caps chat verbosity does not cap the length of a document the skill produces; state the artifact's target separately when it matters.

When a specific verbosity pattern persists (over-explaining, restating the request), add a positive example of the concision you want rather than a "do not" instruction.

## Task scope and over-verification

New on Opus 5 with no 4.8 equivalent: the model can widen a task's scope on its own and re-verify work it already verified. For skill bodies this shows up as a workflow that quietly grows past its declared steps.

State the boundary in the body rather than trusting the step list to hold it:

```markdown
## Scope

This skill changes only the files the step names. When you notice an adjacent problem, record it in the report's Notes section in one line; do not fix it in this run.

Verify each step once. Run the verification command, report the result, move on. Do not re-run passing checks to build confidence.
```

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Task scope and over-verification.

## Subagent spawning (and `context: fork`)

Opus 5 delegates to subagents more readily than prior models. Two implications for skills:

**For inline skills**, the 4.8-era encouragement is now counterproductive. A body that says "spawn multiple subagents in the same turn when fanning out" pushes an already-eager default. Write the boundary instead:

```markdown
Complete work directly when you can already see what needs to change. Spawn a subagent only when the work needs its own context window: broad multi-file search, or research whose raw output you will not need again.
```

**For `context: fork` skills**, the body becomes the subagent task. Brief it like a smart colleague who just walked in:

- State the goal in one sentence.
- Include the surrounding context the subagent cannot infer.
- Specify the deliverable shape, length, citations.
- Add a length cap.

Forked skills with vague tasks ("based on your research, fix the bug") return shallow generic work. Be specific or do not fork. Detail in `${CLAUDE_SKILL_DIR}/references/patterns.md`.

## Thinking, `ultrathink` keyword, adaptive thinking

Claude Code skills enable extended thinking on invoke if the body contains the literal word `ultrathink` anywhere ([Anthropic docs](https://code.claude.com/docs/en/skills.md)). Use this for:

- Deep audits and reviews
- Long-horizon planning
- Skills that benefit from chain-of-thought before action

For API-level skills (not Claude Code), thinking on Opus 5 is on by default. `{ type: "adaptive" }` remains valid and is equivalent to the default, so setting it explicitly is redundant rather than required; this is the change from 4.8, where thinking was off unless requested. The legacy `{ type: "enabled", budget_tokens: N }` shape returns a 400 error on Opus 4.7, Opus 4.8, Opus 5, and Sonnet 5. Disabling thinking with `{ type: "disabled" }` returns a 400 error at effort `xhigh` or `max` on Opus 5; disable only at `high` or below. On Haiku 4.5 the situation is inverted: manual extended thinking is the only accepted shape and adaptive is rejected. Detail in `ac:prompt-writer`'s `references/opus-5-tuning.md`.

## Model overrides, when to set `model:`

| Use case | `model:` value |
|----------|----------------|
| Heavy refactor under a Haiku or Sonnet session | `claude-opus-5` |
| Boilerplate-only skill under an Opus session | `claude-haiku-4-5-20251001` |
| Cost-efficient long-context work | `claude-sonnet-5` |
| Inherit session default | `inherit` or omit |

Override applies for the rest of the current turn and is not saved. Session model resumes on the next user prompt. Carry the `[1m]` suffix when overriding if the user is on a 1M-context session, otherwise the effective window drops to 200K and may trip autocompact mid-skill.

Do not pair `model: claude-haiku-4-5-20251001` with an `effort:` value; Haiku 4.5 does not support the effort parameter.

## Verbosity-sensitive output shapes

Some skill outputs need precise length control. Use positive shape constraints, not negative caps:

```markdown
## Output shape

A markdown report with these sections, each with `file_path:line_number` citations:

- Feature purpose, one sentence
- Entry points, bullet list
- Core logic, three to five function signatures
- Data flow, one canonical path traced end-to-end
- Risks for change, one to three items

Under 800 words. Lead with the feature's purpose.
```

The model self-regulates to the shape. Adding "do not be verbose" on top hurts because it conflicts with the explicit structure. On Opus 5 the explicit shape matters more than it did on 4.8, because the default length is higher.

## User-facing progress updates

Opus 5 produces regular, high-quality interim updates natively across long traces, same as 4.8. Remove old scaffolding like "after every 3 tool calls, summarize progress"; it overtriggers without improving the updates.

Opus 5 additionally narrates self-correction: when it revises its own approach mid-task, it says so. If that reads as churn in the skill's output surface, describe the update style you want with an example rather than suppressing the narration:

```markdown
After each tool call that produces user-visible findings, write a one-sentence update in present tense, like: "Found 3 routing issues in app/Http/Controllers." Do not narrate internal deliberation.
```

## Long-horizon skills (compact-survival)

Auto-compact preserves the first 5,000 tokens of each invoked skill, shared across all skills in a 25,000-token budget filled most-recent first. Author for compact survival:

- **Put standing instructions in the top 5,000 tokens.** Anything below may be cut. Background, edge cases, and reference pointers go later.
- **Re-attached skills warn against re-execution.** Claude Code injects a system reminder after compact telling the model not to re-run one-time setup actions (scheduling, file creation) or treat earlier `## Input` sections as the user's current message. Author bodies so the standing parts are safe to re-attach without re-running.
- **For ultra-long sessions**, add: "Your context window will be compacted as it approaches its limit; you can continue working indefinitely from where you left off. Do not stop tasks early due to token budget. Save current progress to memory before the context refreshes."

## Frontend and visual output

The 4.8 prompting page documented a persistent house style (warm cream backgrounds around `#F4F1EA`, serif display fonts, terracotta accents) and the strategies that break it. The Opus 5 prompting page has no design-defaults section at all, so whether that house style persists on Opus 5 is undocumented. Do not write a skill body that assumes either answer.

What holds regardless of model, because it is a specificity argument rather than a model-behavior claim:

- Pick a font family explicitly; specify a usable stack like `font: 14px/1.5 system-ui, sans-serif` rather than relying on a default choice.
- State the color palette explicitly. "Use a dark theme with `#1a1a2e` background, `#252542` sidebar, `#3d3d5c` borders, `#eee` body text." A named palette beats "modern color scheme".
- For variety across runs, have the skill propose distinct visual directions and let the user pick one before building.
- Bundle a script for the heavy lifting and orchestrate around it. See Example 4 in `${CLAUDE_SKILL_DIR}/references/examples.md`.

Generic negations ("make it clean", "do not use cream") shifted 4.8 to a different fixed palette rather than producing variety; there is no reason to expect a negation to work better on any model.

## Sonnet 5 quick deltas

Sonnet 5 follows the same body shape as Opus 5 with these differences:

- Default effort is `high`, all five levels supported. Drop one level versus Opus for cost-sensitive skills.
- Adaptive thinking is default-on; manual extended thinking (`{ type: "enabled", budget_tokens: N }`) is removed and returns a 400 error, not merely deprecated.
- Non-default `temperature` / `top_p` / `top_k` values return a 400 error, same as Opus 5.
- 1M context and 128k max output, matching Opus 5. Pricing $3 / $15 per MTok versus Opus 5's $5 / $25.
- Tokenizer produces roughly 30% more tokens than Sonnet 4.6 for equivalent text; re-baseline any token-count estimate carried over from Sonnet 4.6.
- On the hardest work Sonnet 5 is not a near-peer: Opus 5 leads it by about 16 points on SWE-bench Pro and 27 points on FrontierBench v0.1. For a skill whose correctness matters more than its cost, set `model: claude-opus-5` rather than inheriting a Sonnet session.

If a skill must run reliably on both Opus 5 and Sonnet 5, do not set `model:` or `effort:`. Let the session inherit, and do not write a body that assumes a specific model's quirks.

## Haiku 4.5 quick deltas

Haiku 4.5 is for short, scoped tasks where speed matters and reasoning depth does not. There is no Haiku 5.

- **The `effort` parameter is not supported.** Do not set `effort:` on a skill targeted at Haiku 4.5, and scope the work through the body instead.
- Adaptive thinking is not accepted. Manual extended thinking is, with the legacy `{ type: "enabled", budget_tokens: N }` shape.
- Verbosity calibration is less reliable; explicit length caps in the body matter more.
- 200k context, 64k max output, $1 / $5 per MTok.

Use Haiku 4.5 via `model: claude-haiku-4-5-20251001` for boilerplate, formatting, simple lookups. Do not use it for skills that require multi-step reasoning across many files; quality drops sharply past the third or fourth dependent decision.
