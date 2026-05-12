# Opus 4.7 Tuning for Skill Bodies

Skill-specific tuning for the current Claude family. Default target is Opus 4.7 (`claude-opus-4-7`). Sonnet 4.6 (`claude-sonnet-4-6`) and Haiku 4.5 (`claude-haiku-4-5-20251001`) follow the same patterns at lower effort levels. This reference focuses on the knobs that matter when authoring the body of a skill; for prompt-architecture tuning beyond skills, route through `ac:prompt-writer/references/opus-4-7-tuning.md`.

## Contents

- Effort and the `effort:` frontmatter field
- Verbosity, self-calibration removes hedges
- Tool use conservatism, raise the floor not the ceiling
- Literal interpretation, state scope every time
- Subagent spawning (and `context: fork`)
- Thinking, `ultrathink` keyword, adaptive thinking
- Model overrides, when to set `model:`
- Verbosity-sensitive output shapes
- Long-horizon skills (compact-survival)
- Frontend and visual output
- Sonnet 4.6 quick deltas
- Haiku 4.5 quick deltas

## Effort and the `effort:` frontmatter field

| Effort | Use for | Notes |
|--------|---------|-------|
| `xhigh` | Coding and agentic work, the default for skill execution | Set this for any skill that touches code, runs migrations, edits configs, or chains tool calls |
| `high` | Intelligence-sensitive non-coding tasks | Audits, reviews, deep research |
| `medium` | Cost or latency-sensitive tasks where intelligence still matters | Shorter reports, summarization |
| `low` | Short scoped tasks | Quick formatters, lookups |
| `max` | Hardest problems | Diminishing returns past `xhigh` |

Set `effort:` only when the skill needs a different reasoning budget than the session default. Most skills inherit fine. A complex audit skill at `effort: high`, a quick formatter skill at `effort: low`. Anything outside that range usually means the skill is doing too much; split it.

If you see shallow reasoning, raise effort instead of papering over with prompt instructions. A clearer rule at `effort: medium` rarely beats the same body at `effort: high`.

## Verbosity, self-calibration removes hedges

Opus 4.7 self-calibrates response length to perceived task complexity. Old hedges from earlier models hurt outcomes:

- Drop "be concise", "do not be verbose", "avoid long responses". These are negative-only and force the model to imagine the wrong behavior first.
- If you need a specific length, ask positively. "Provide concise, focused responses. Lead with the answer, then add at most three supporting sentences."
- For reports, state the shape and a soft length cap. "Under 800 words. Lead with the feature's purpose in one sentence."

The model removes filler on its own when the task is clear. If output is verbose despite a clear task, the body is asking for too much (multiple deliverables, optional sections, scenic background) or `effort` is set too low.

## Tool use conservatism, raise the floor not the ceiling

Opus 4.7 reasons more and calls tools less than 4.6. To get more tool calls from a skill:

- Raise `effort:` (the most reliable lever).
- Describe when and how explicitly: "Read the existing file before editing. Re-read after each Edit to verify the change applied. Run the test command after every code change."
- Name the tool by its actual identity: "Use `Read` to load `<file>`", "Run `Bash(npm test:*)` to verify".

What does not work:

- "CRITICAL: ALWAYS use this tool." Aggressive caps trigger weird compliance behaviors and skew the trigger decision.
- Wishful thinking. The model decides based on perceived need; rewrite the body so the need is visible.

## Literal interpretation, state scope every time

Opus 4.7 does not silently generalize. A rule in section 2 will not automatically apply to section 5 unless the body says so.

```markdown
## Apply to every code block, not just the first

After every Edit, re-read the file and verify the change landed. This applies to every Edit in this workflow, not only the first.
```

Variants of "for each X" reduce false-positive narrow-scope misreadings:

- "For every step in the workflow, before continuing..."
- "Across the whole task, never..."
- "This rule holds throughout the skill, not just for step 1."

When a rule needs to span sections, say so. When a rule applies only once, say so too.

## Subagent spawning (and `context: fork`)

Opus 4.7 spawns subagents less aggressively by default. Two implications for skills:

**For inline skills with fan-out work**, write: "Spawn multiple subagents in the same turn when fanning out across items. Do not spawn for work you can complete in a single response." This raises the floor without telling the model to always spawn.

**For `context: fork` skills**, the body becomes the subagent task. Brief it like a smart colleague who just walked in:

- State the goal in one sentence.
- Include the surrounding context the subagent cannot infer.
- Specify the deliverable shape, length, citations.
- Add a length cap.

Forked skills with vague tasks ("based on your research, fix the bug") return shallow generic work. Be specific or do not fork. Detail in `${CLAUDE_SKILL_DIR}/references/patterns.md`.

## Thinking, `ultrathink` keyword, adaptive thinking

Claude Code skills enable extended thinking on invoke if the body contains the literal word `ultrathink` anywhere ([Anthropic docs](https://docs.claude.com/en/docs/claude-code/skills.md)). Use this for:

- Deep audits and reviews
- Long-horizon planning
- Skills that benefit from chain-of-thought before action

For API-level skills (not Claude Code), the `thinking` parameter on Opus 4.7 and Sonnet 4.6 is `{ type: "adaptive" }`. The legacy `{ type: "enabled", budget_tokens: N }` shape no longer applies on these models. Detail in `ac:prompt-writer/references/opus-4-7-tuning.md`.

## Model overrides, when to set `model:`

| Use case | `model:` value |
|----------|----------------|
| Heavy refactor under a Haiku session | `claude-opus-4-7` |
| Boilerplate-only skill under an Opus session | `claude-haiku-4-5-20251001` |
| Sonnet sweet spot for long context | `claude-sonnet-4-6` |
| Inherit session default | `inherit` or omit |

Override applies for the rest of the current turn and is not saved. Session model resumes on the next user prompt. Carry the `[1m]` suffix when overriding if the user is on Opus 4.7 1M context, otherwise the effective window drops to 200K and may trip autocompact mid-skill.

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

The model self-regulates to the shape. Adding "do not be verbose" on top hurts because it conflicts with the explicit structure.

## Long-horizon skills (compact-survival)

Auto-compact preserves the first 5,000 tokens of each invoked skill, shared across all skills in a 25,000-token budget filled most-recent first. Author for compact survival:

- **Put standing instructions in the top 5,000 tokens.** Anything below may be cut. Background, edge cases, and reference pointers go later.
- **Re-attached skills warn against re-execution.** Claude Code injects a system reminder after compact telling the model not to re-run one-time setup actions (scheduling, file creation) or treat earlier `## Input` sections as the user's current message. Author bodies so the standing parts are safe to re-attach without re-running.
- **For ultra-long sessions**, add: "Your context window will be compacted as it approaches its limit; you can continue working indefinitely from where you left off. Do not stop tasks early due to token budget. Save current progress to memory before the context refreshes."

## Frontend and visual output

Skills that generate frontend artifacts (HTML, dashboards, charts, visualizations) benefit from positive specificity:

- Pick a font family that is not the system default; specify a usable stack like `font: 14px/1.5 system-ui, sans-serif` rather than relying on the model's default choice (which trends toward "AI-slop" generic looks).
- State the color palette explicitly. "Use a dark theme with `#1a1a2e` background, `#252542` sidebar, `#3d3d5c` borders, `#eee` body text." A named palette beats "modern color scheme".
- Bundle a script for the heavy lifting and orchestrate around it. See Example 4 in `${CLAUDE_SKILL_DIR}/references/examples.md`.

## Sonnet 4.6 quick deltas

Sonnet 4.6 follows the same shape as Opus 4.7 with these differences:

- Drop `effort` one level vs Opus (where Opus uses `high`, Sonnet uses `medium`).
- Adaptive thinking still applies (`thinking: { type: "adaptive" }` on the API).
- Tool use is slightly less conservative than Opus 4.7 by default.
- Long-context behavior is strong (1M context available); some teams prefer Sonnet 4.6 for long-document RAG over Opus 4.7.

If a skill must run reliably on both Opus 4.7 and Sonnet 4.6, do not set `model:` or `effort:`. Let the session inherit. The body should not assume a specific model's quirks.

## Haiku 4.5 quick deltas

Haiku 4.5 is for short, scoped tasks where speed matters and reasoning depth does not.

- Adaptive thinking is not supported on Haiku 4.5. Manual extended thinking is, with the legacy `{ type: "enabled", budget_tokens: N }` shape.
- Tool use is more permissive than Opus 4.7; the floor for spawning subagents and running parallel calls is lower.
- Verbosity calibration is less reliable; explicit length caps in the body matter more.
- Effort levels: `low` and `medium` only.

Use Haiku 4.5 via `model: claude-haiku-4-5-20251001` for boilerplate, formatting, simple lookups. Do not use it for skills that require multi-step reasoning across many files; quality drops sharply past the third or fourth dependent decision.
