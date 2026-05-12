# Opus 4.7 Tuning

Specific, load-bearing knobs for `claude-opus-4-7`. Read this when writing or debugging a prompt for Opus 4.7, or when porting a prompt up from Opus 4.6 or Sonnet 4.6.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Migration guide: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md
- What's new in Claude Opus 4.7: https://docs.claude.com/en/docs/about-claude/models/whats-new-claude-4-7.md
- Extended thinking: https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md
- Models overview: https://docs.claude.com/en/docs/models-overview.md
- Prompt engineering best practices: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md

## Why this matters

Opus 4.7 performs well on existing 4.6 prompts most of the time. The patterns below are the behaviors that most often need tuning when porting. Each explains the behavior, the why, and the lever you have. Where a behavior is a breaking change vs 4.6, it is flagged.

## Effort and thinking depth

The `effort` parameter trades intelligence for tokens and latency. Opus 4.7 respects effort more strictly than 4.6, especially at the low end.

Source: https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md > Effort levels.

| Effort | Use for | What 4.7 does |
|---|---|---|
| `max` | Hardest, intelligence-demanding tasks | Maximum reasoning. Diminishing returns on token usage; prone to overthinking. Test before committing. |
| `xhigh` (new on 4.7) | Coding, agentic loops, long-horizon work | Best setting for most coding and agentic use cases. Spawns more subagents and uses more tools at this level. |
| `high` | Intelligence-sensitive non-coding work | Balances tokens and intelligence. Minimum recommended for tasks where intelligence matters. |
| `medium` | Cost-sensitive work | Scopes work to what was asked. Risk of under-thinking on complex tasks. |
| `low` | Short scoped tasks, latency-critical | More aggressive scoping. Reserve for simple lookups. |

**The rule.** When you see shallow reasoning on a complex problem, raise effort. Do not paper over with prompt instructions. Effort is the cleaner lever.

**Token budget.** At `xhigh` or `max`, set `max_tokens` to roughly 64k. The model needs room to think and act across subagents and tool calls. Maximum output tokens on Opus 4.7 is 128k; Sonnet 4.6 and Haiku 4.5 are 64k.

Source: https://docs.claude.com/en/docs/models-overview.md (latest-models comparison table, "Max output" row) and https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md > Output token limits.

**Prompt fallback for low effort.** If latency forces `low`:

```text
This task involves multi-step reasoning. Think carefully through the problem before responding.
```

**Reduce thinking when 4.7 thinks too much.** Large or complex system prompts can make 4.7 think more than you want. Steer it:

```text
Thinking adds latency and should only be used when it will meaningfully improve answer quality, typically for problems that require multi-step reasoning. When in doubt, respond directly.
```

## Adaptive thinking (replaces `budget_tokens` on Opus 4.7)

**Breaking change on Opus 4.7.** Manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`) is no longer accepted and returns a 400 error. Switch to adaptive thinking and steer depth via the `effort` parameter.

```python
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=64000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},  # max, xhigh, high, medium, low
    messages=[{"role": "user", "content": "..."}],
)
```

Note: `client.messages.create` (not `client.beta.messages.create`). Adaptive thinking and effort are GA; remove any `betas=["effort-2025-11-24"]` header you carried over.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migrating to Claude Opus 4.7 > Breaking changes, and https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md > Supported models.

**Other Claude models in the 4.6 / 4.5 generation.** Manual extended thinking is still functional (deprecated and will be removed). Adaptive thinking is recommended on Opus 4.6 and Sonnet 4.6.

**Display thinking content.** If the UI needs to render thinking:

```json
{"type": "adaptive", "display": "summarized"}
```

Otherwise thinking content is hidden from the response. On Claude Mythos Preview the default is `display: "omitted"`; pass `"summarized"` to receive summaries.

## Tool use is conservative

4.7 reasons more, calls tools less than 4.6. This is the right default in most cases. When you need more tool use:

1. Raise effort to `high` or `xhigh` first.
2. Describe explicitly when and how to use the tool. Cite specific scenarios.
3. Do not write "CRITICAL: you MUST use this tool when X" or "ALWAYS use the search tool." 4.7 (and 4.6) follow aggressive language too literally and overtrigger.

Plain phrasing wins:

```text
Use the search tool when the user asks about content from the codebase you have not opened.
```

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes (tool triggering), and https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Be clear and direct.

## Literal instruction following

**Behavior change vs 4.6.** 4.7 will not silently generalize. If you write "format the title in italics," it formats only that title, not other titles in the document. If you write "use TypeScript strict mode," it does not infer that you also want strict mode in adjacent files.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Literal interpretation.

**The fix.** State scope explicitly. Always.

```text
Apply this formatting rule to every section heading, not just the first one.
Use TypeScript strict mode in every file you create or modify, not only in the new ones.
```

The compensation is precision: 4.7 does exactly what you ask, no thrash, no surprise generalization. Carefully tuned API prompts run more reliably.

## Verbosity self-calibrates

4.7 picks length based on perceived task complexity. Short answers on lookups, long on open analysis.

**To reduce verbosity (positive instruction):**

```text
Provide concise, focused responses. Skip non-essential context, and keep examples minimal.
```

**Positive examples beat negative instructions.** Show one short response you like rather than writing "do not be verbose." The model maps to the example. Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Use examples effectively.

**To increase tool-use visibility (4.7 may skip summaries):**

```text
After completing a task that involves tool use, provide a quick summary of the work you have done. One sentence per tool call.
```

## Subagent spawning is lower by default

4.7 spawns fewer subagents than 4.6 unprompted. Steer it explicitly when you want fan-out:

```text
Do not spawn a subagent for work you can complete directly in a single response (e.g., refactoring a function you can already see).

Spawn multiple subagents in the same turn when fanning out across items or reading multiple files.
```

The reverse problem (overuse) is rare on 4.7 but possible on 4.6:

```text
Use subagents when tasks can run in parallel, require isolated context, or involve independent workstreams that do not need to share state. For simple tasks, sequential operations, single-file edits, or tasks where you need to maintain context across steps, work directly rather than delegating.
```

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Subagent behavior.

## User-facing progress updates

**Removal of 4.6-era scaffolding.** 4.7 produces higher-quality interim updates natively. Remove old scaffolding like "after every 3 tool calls, summarize progress." That scaffolding was a 4.6-era hack; on 4.7 it causes overtriggering.

If 4.7's update style does not match your product (too brief, wrong format), describe what you want and provide an example:

```text
After each tool call that produces user-visible findings, write a one-sentence update in present tense, like: "Found 3 routing issues in app/Http/Controllers." Do not narrate internal deliberation.
```

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Progress updates.

## Prose tone

4.7 is more direct and opinionated than 4.6. Less validation-forward phrasing, fewer emoji.

**If your product voice needs warmth:**

```text
Use a warm, collaborative tone. Acknowledge the user's framing before answering. Avoid clipped or curt phrasing. Be encouraging without being sycophantic.
```

**If your product voice needs more directness:** no extra prompting needed.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Tone.

## Frontend defaults are persistent

4.7 has a strong default house style: cream backgrounds (`#F4F1EA`), serif display fonts (Georgia, Fraunces, Playfair), italic word-accents, terracotta/amber accents. It reads well for editorial, hospitality, portfolio. Wrong for dashboards, dev tools, fintech, healthcare, enterprise.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Frontend output style.

**Generic instructions do not help.** "Make it clean and minimal" shifts to a different fixed palette, not variety. "Don't use cream" picks a different default.

**Two approaches that work.**

**1. Concrete spec.** Hex codes, named typeface, layout structure. The model follows specs precisely:

```text
Color palette: #E9ECEC, #C9D2D4, #8C9A9E, #44545B, #11171B.
Typography: square, angular sans-serif (Inter Tight or similar) with wider letter spacing in headings.
Layout: clear horizontal sections, centered max-width container, 4px corner radius across cards/buttons/inputs/media frames.
```

**2. Propose-then-pick.** Have the model show options before building. This breaks the default and gives the user control:

```text
Before building, propose 4 distinct visual directions tailored to this brief (each as: bg hex / accent hex / typeface, with a one-line rationale). Ask the user to pick one, then implement only that direction.
```

**Anti-AI-slop snippet (positive variant, pair with above):**

```text
<frontend_aesthetics>
Pick a font family that is not Inter, Roboto, Arial, or a system default. Pick a color scheme that is not a purple gradient on white or dark. Pick a layout that has at least one signature element (an unusual grid, an asymmetric hero, a custom motion treatment). Use micro-interaction animations on hover and focus states. Build around one specific brand prior (a single reference site, a stated mood word, or three palette anchors) rather than a generic minimalist baseline.
</frontend_aesthetics>
```

This is the positive-form rewrite of the older "avoid generic AI-generated aesthetics" wording. Positive instructions outperform negative ones (see `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` > Negative-only instructions).

## Code review harnesses may need re-tuning

4.7 is meaningfully better at finding bugs (Anthropic's published delta is an 11pp recall improvement on their hardest internal eval). But if your code-review harness was tuned for 4.6, you may see lower recall initially.

**Why.** When a review prompt says "be conservative," "only report high-severity," or "don't nitpick," 4.7 follows that more faithfully than 4.6 did. Same depth of investigation, fewer reported findings.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Behavior changes > Code review.

**Fix.** Move filtering downstream. Tell the model its job is coverage:

```text
Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage; a separate verification step will do that. Your goal here is coverage: it is better to surface a finding that later gets filtered out than to silently drop a real bug. For each finding, include your confidence level and an estimated severity so a downstream filter can rank them.
```

If you want self-filtering in a single pass, be concrete about the bar:

```text
Report any bugs that could cause incorrect behavior, a test failure, or a misleading result. Only omit nits like pure style or naming preferences.
```

## Prefilled assistant responses are deprecated

**Breaking change vs older models.** On Opus 4.6 and later, prefilling the last assistant message returns a 400 error. The whole "`{`" prefill trick is dead.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Breaking changes > Prefill removal.

Migration paths:

| Old prefill use | Migration on 4.7 |
|---|---|
| Force JSON / YAML output | Structured Outputs (`response_format: { type: "json_schema", ... }`) |
| Force classification label | Tool call with enum, or Structured Outputs |
| Skip preamble | Direct instruction in system prompt: "Respond directly without preamble. Do not start with 'Here is...' or 'Based on...'" |
| Continue interrupted response | Move continuation to a new user message: "Your previous response was interrupted and ended with `[snippet]`. Continue from where you left off." |
| Steer around bad refusals | Not needed on 4.6+; refusals are appropriately calibrated. |

Prefills on earlier assistant turns (not the last one) still work.

## Image coordinates are 1:1

**Breaking change vs 4.6.** On Opus 4.7, image pointing and bounding-box coordinates are 1:1 with actual image pixels. Earlier versions used a scale-factor conversion. Remove any client-side coordinate transforms.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Breaking changes > Image coordinates.

## Tokenization changed

**Cost/latency change vs 4.6.** Opus 4.7 uses a different tokenizer. Re-baseline end-to-end cost and latency, and re-tune any client-side token-count estimations.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migration checklist.

## Interactive vs autonomous coding

4.7 uses more tokens in interactive (multi-turn) coding sessions because it reasons more after each user turn. This improves long-horizon coherence and instruction following.

**To maximize performance and token efficiency:**

1. Use `xhigh` or `high` effort.
2. Reduce required user interactions; add an auto mode if your product allows.
3. Specify task, intent, and constraints upfront in the first user turn. Underspecified prompts spread across multiple turns reduce both efficiency and performance.

## Long-horizon and context awareness

4.6 and 4.5 already have context awareness (track remaining context window). 4.7 inherits this. To make use of it:

```text
Your context window will be automatically compacted as it approaches its limit, allowing you to continue working indefinitely from where you left off. Do not stop tasks early due to token budget concerns. As you approach your token budget limit, save your current progress and state to memory before the context window refreshes. Always be as persistent and autonomous as possible and complete tasks fully, even if the end of your budget is approaching. Never artificially stop any task early regardless of the context remaining.
```

Pair with the memory tool or filesystem state files (`progress.txt`, `tests.json`). Source: https://docs.claude.com/en/docs/build-with-claude/compaction.md > Context awareness pattern.

## Sonnet 4.6 quick deltas

If your prompt targets `claude-sonnet-4-6` instead of Opus 4.7:

- Default effort is `high` (Sonnet 4.5 had no effort param). Set explicitly to avoid latency.
- `medium` for most applications, `low` for high-volume or latency-sensitive workloads.
- 64k `max_tokens` recommended at `medium`/`high`.
- Use Opus 4.7 instead for the hardest, longest-horizon problems (large code migrations, deep research, extended autonomous work). Sonnet 4.6 is for fast, cost-efficient workloads.
- Sonnet 4.6 context window: 1M tokens (per `https://docs.claude.com/en/docs/models-overview.md`).

Source: https://docs.claude.com/en/docs/models-overview.md and https://docs.claude.com/en/docs/build-with-claude/extended-thinking.md.

## Haiku 4.5 quick deltas

`claude-haiku-4-5-20251001` is for latency-sensitive and high-throughput pipelines.

- 64k `max_tokens`.
- Context window: 200k tokens (smaller than Opus 4.7 and Sonnet 4.6's 1M).
- Use `medium` or `low` effort.
- **Thinking shape on Haiku 4.5 differs from Opus 4.7.** Haiku 4.5 accepts manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`); it does NOT accept adaptive thinking. If you are sharing a prompt path between models, branch on model ID and use the right shape per side.

Source: https://docs.claude.com/en/docs/models-overview.md (latest-models comparison table, "Extended thinking" and "Adaptive thinking" rows).

## Computer use

Computer use works up to 2576px / 3.75MP resolution. 1080p is the sweet spot for performance and cost. 720p or 1366x768 for cost-sensitive workloads.

Source: https://docs.claude.com/en/docs/agents-and-tools/tool-use/computer-use-tool.md.

## Quick checklist for Opus 4.7 prompts

- [ ] `thinking: { type: "adaptive" }` (not `enabled` + `budget_tokens`).
- [ ] `effort` set explicitly; `xhigh` for coding/agentic, `high` for intelligence-sensitive.
- [ ] `max_tokens` 64k at `xhigh`/`max`.
- [ ] Scope stated explicitly on every rule ("apply to every X, not just the first").
- [ ] No "CRITICAL / MUST / ALWAYS" wording on tool use.
- [ ] No prefill on the last assistant turn.
- [ ] No image-coordinate scale-factor math.
- [ ] No "after every N tool calls, summarize" scaffolding from 4.6 era.
- [ ] Verbosity tuned with positive examples, not "do not be verbose."
- [ ] Frontend brief includes concrete spec or propose-then-pick.
- [ ] Code-review harness uses coverage-first or explicit severity bar.
