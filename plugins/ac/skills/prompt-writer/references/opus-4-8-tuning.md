# Opus 4.8 Tuning

Specific, load-bearing knobs for `claude-opus-4-8`. Read this when writing or debugging a prompt for Opus 4.8, or when tuning a prompt up from Opus 4.7, 4.6, or Sonnet 4.6.

Primary sources (raw markdown via the `.md` suffix on `docs.claude.com`):

- Prompting Claude Opus 4.8: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md
- Migration guide: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md
- What's new in Claude Opus 4.8: https://docs.claude.com/en/docs/about-claude/models/whats-new-claude-4-8.md
- Adaptive thinking: https://docs.claude.com/en/docs/build-with-claude/adaptive-thinking.md
- Models overview: https://docs.claude.com/en/docs/about-claude/models/overview.md
- Prompt engineering best practices: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md

## Why this matters

Opus 4.8 performs well out of the box on existing 4.7 prompts. 4.7 to 4.8 is tuning, not porting: there are no breaking API changes, and the model supports the same feature set (1M context, 128k max output, adaptive thinking, prompt caching, vision). The patterns below are the behaviors that most often benefit from tuning. Each explains the behavior, the why, and the lever you have. Breaking changes that 4.7 introduced and 4.8 carries forward unchanged are flagged for prompts coming from 4.6 or earlier.

## Effort and thinking depth

The `effort` parameter trades intelligence for tokens and latency. Opus 4.8 respects effort strictly, more so than any prior Opus, especially at the low end.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Calibrating effort and thinking depth.

| Effort | Use for | What 4.8 does |
|---|---|---|
| `max` | Hardest, intelligence-demanding tasks | Maximum reasoning. Diminishing returns on token usage; prone to overthinking. Test before committing. |
| `xhigh` | Coding, agentic loops, long-horizon work | Best setting for most coding and agentic use cases. Substantially more tool use and subagent spawning at this level. |
| `high` | Intelligence-sensitive non-coding work | Session default; the minimum for tasks where intelligence matters. Balances tokens and intelligence. |
| `medium` | Cost-sensitive work | Scopes work to what was asked. Risk of under-thinking on complex tasks. |
| `low` | Short scoped tasks, latency-critical | Aggressive scoping. Reserve for simple lookups; at `low` the model scopes tightly to the literal ask. |

**The rule.** When you see shallow reasoning on a complex problem, raise effort to `high` or `xhigh`. Do not paper over with prompt instructions. Effort is the cleaner lever, and it matters more on 4.8 than on prior Opus, so experiment with it actively when you upgrade.

**Token budget.** At `xhigh` or `max`, set `max_tokens` to roughly 64k. The model needs room to think and act across subagents and tool calls. Maximum output tokens on Opus 4.8 is 128k; Sonnet 4.6 and Haiku 4.5 are 64k.

Source: https://docs.claude.com/en/docs/about-claude/models/overview.md (latest-models comparison table, "Max output" row).

**Prompt fallback for low effort.** If latency forces `low`:

```text
This task involves multi-step reasoning. Think carefully through the problem before responding.
```

**Reduce thinking when 4.8 thinks too much.** Large or complex system prompts can make 4.8 trigger adaptive thinking more than you want. Steer it:

```text
Thinking adds latency and should only be used when it will meaningfully improve answer quality, typically for problems that require multi-step reasoning. When in doubt, respond directly.
```

## Adaptive thinking

On Opus 4.8 thinking is off unless you set `thinking: {type: "adaptive"}` explicitly; depth is then steered by `effort`. Manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`) is not accepted and returns a 400 error. This is the same shape Opus 4.7 introduced; for prompts coming from 4.6 or earlier it is a breaking change.

```python
client.messages.create(
    model="claude-opus-4-8",
    max_tokens=64000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},  # max, xhigh, high, medium, low
    messages=[{"role": "user", "content": "..."}],
)
```

Note: `client.messages.create` (not `client.beta.messages.create`). Adaptive thinking and effort are GA; remove any `betas=["effort-2025-11-24"]` header carried over from an earlier integration.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migrating from Claude Opus 4.7 to Claude Opus 4.8, and https://docs.claude.com/en/docs/build-with-claude/adaptive-thinking.md > Supported models.

**Other Claude models in the 4.6 / 4.5 generation.** Manual extended thinking is still functional on Haiku 4.5 (it is the only supported shape there); adaptive thinking is recommended on Opus 4.6 and Sonnet 4.6.

**Display thinking content.** If the UI needs to render thinking:

```json
{"type": "adaptive", "display": "summarized"}
```

Otherwise thinking content is hidden from the response.

## Tool use is conservative

4.8 favors reasoning over tool calls. This is the right default in most cases. When you need more tool use:

1. Raise effort to `high` or `xhigh` first; both show substantially more tool use in agentic search and coding.
2. Describe explicitly when and how to use the tool. Cite specific scenarios, and explain why and how the model should reach for it.
3. Do not write "CRITICAL: you MUST use this tool when X" or "ALWAYS use the search tool." 4.8 follows aggressive language too literally and overtriggers.

Plain phrasing wins:

```text
Use the search tool when the user asks about content from the codebase you have not opened.
```

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Tool use triggering, and https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices.md > Be clear and direct.

## Literal instruction following

4.8 interprets prompts literally and explicitly, particularly at lower effort. It does not silently generalize an instruction from one item to another, and it does not infer requests you did not make. If you write "format the title in italics," it formats only that title, not other titles in the document. If you write "use TypeScript strict mode," it does not infer that you also want strict mode in adjacent files.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > More literal instruction following.

**The fix.** State scope explicitly where a rule must span.

```text
Apply this formatting rule to every section heading, not just the first one.
Use TypeScript strict mode in every file you create or modify, not only in the new ones.
```

The compensation is precision: 4.8 does exactly what you ask, no thrash, no surprise generalization, which is why it performs well on carefully tuned API prompts, structured extraction, and pipelines. Because the model already follows literally, blanket "for each / every" reinforcement across a prompt reads as noise; state scope once where it matters and drop the defensive restatement.

## Verbosity self-calibrates

4.8 calibrates length to perceived task complexity. Short answers on lookups, much longer ones on open-ended analysis.

**To reduce verbosity (positive instruction):**

```text
Provide concise, focused responses. Skip non-essential context, and keep examples minimal.
```

**Positive examples beat negative instructions.** Show one short response you like rather than writing "do not be verbose." The model maps to the example. If a specific verbosity pattern persists (over-explaining, for instance), add a targeted positive example for that case. Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Response length and verbosity.

## Subagent spawning is lower by default

4.8 spawns fewer subagents unprompted. This behavior is steerable; give explicit guidance when you want fan-out:

```text
Do not spawn a subagent for work you can complete directly in a single response (e.g., refactoring a function you can already see).

Spawn multiple subagents in the same turn when fanning out across items or reading multiple files.
```

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Controlling subagent spawning.

## User-facing progress updates

4.8 provides regular, higher-quality interim updates natively throughout long agentic traces. Remove old scaffolding like "after every 3 tool calls, summarize progress." On 4.8 that scaffolding overtriggers without improving the updates.

If 4.8's update style does not match your product (too brief, wrong format), describe what you want and provide an example:

```text
After each tool call that produces user-visible findings, write a one-sentence update in present tense, like: "Found 3 routing issues in app/Http/Controllers." Do not narrate internal deliberation.
```

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > User-facing progress updates.

## Prose tone

4.8 tends toward a direct, opinionated style with minimal validation-forward phrasing and sparing emoji.

**If your product voice needs warmth:**

```text
Use a warm, collaborative tone. Acknowledge the user's framing before answering. Avoid clipped or curt phrasing. Be encouraging without being sycophantic.
```

**If your product voice needs more directness:** no extra prompting needed.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Tone and writing style.

## Frontend defaults are persistent

4.8 has a strong default house style: warm cream backgrounds (around `#F4F1EA`), serif display fonts (Georgia, Fraunces, Playfair), italic word-accents, terracotta/amber accents. It reads well for editorial, hospitality, portfolio. Wrong for dashboards, dev tools, fintech, healthcare, enterprise. The default appears in slide decks as well as web UIs.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Design and frontend defaults.

**Generic instructions do not help.** "Make it clean and minimal" shifts to a different fixed palette, not variety. "Do not use cream" picks a different default.

**Two approaches that work.**

**1. Concrete spec.** Hex codes, named typeface, layout structure. The model follows specs precisely:

```text
Color palette: #E9ECEC, #C9D2D4, #8C9A9E, #44545B, #11171B.
Typography: square, angular sans-serif (Inter Tight or similar) with wider letter spacing in headings.
Layout: clear horizontal sections, centered max-width container, 4px corner radius across cards/buttons/inputs/media frames.
```

**2. Propose-then-pick.** Have the model show options before building. This breaks the default and gives the user control, and produces meaningfully different directions across runs:

```text
Before building, propose 4 distinct visual directions tailored to this brief (each as: bg hex / accent hex / typeface, with a one-line rationale). Ask the user to pick one, then implement only that direction.
```

**Frontend aesthetics snippet.** 4.8 needs less anti-slop prompting than earlier models; a short snippet pairs well with the variety advice above:

```text
<frontend_aesthetics>
Pick a font family that is not Inter, Roboto, Arial, or a system default. Pick a color scheme that is not a purple gradient on white or dark. Pick a layout that has at least one signature element (an unusual grid, an asymmetric hero, a custom motion treatment). Use micro-interaction animations on hover and focus states. Build around one specific brand prior (a single reference site, a stated mood word, or three palette anchors) rather than a generic minimalist baseline.
</frontend_aesthetics>
```

Positive instructions outperform negative ones (see `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` > Negative-only instructions).

## Code review harnesses may need re-tuning

4.8 is meaningfully better at finding bugs, with higher recall and precision in internal evals. But if your code-review harness was tuned for an earlier model, you may see lower recall initially. This is a harness effect, not a capability regression.

**Why.** When a review prompt says "be conservative," "only report high-severity," or "don't nitpick," 4.8 follows that more faithfully than earlier models did. It investigates just as thoroughly, finds the bugs, then drops findings below your stated bar. Precision rises; measured recall can fall.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Code review harnesses.

**Fix.** Move filtering downstream. Tell the model its job is coverage:

```text
Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage; a separate verification step will do that. Your goal here is coverage: it is better to surface a finding that later gets filtered out than to silently drop a real bug. For each finding, include your confidence level and an estimated severity so a downstream filter can rank them.
```

If you want self-filtering in a single pass, be concrete about the bar:

```text
Report any bugs that could cause incorrect behavior, a test failure, or a misleading result. Only omit nits like pure style or naming preferences.
```

## Prefilled assistant responses are deprecated

On Opus 4.6 and later, prefilling the last assistant message returns a 400 error. The whole "`{`" prefill trick is dead. This applies on 4.8 the same as on 4.7.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Breaking changes > Prefill removal.

Migration paths:

| Old prefill use | Migration on 4.8 |
|---|---|
| Force JSON / YAML output | Structured Outputs (`response_format: { type: "json_schema", ... }`) |
| Force classification label | Tool call with enum, or Structured Outputs |
| Skip preamble | Direct instruction in system prompt: "Respond directly without preamble. Do not start with 'Here is...' or 'Based on...'" |
| Continue interrupted response | Move continuation to a new user message: "Your previous response was interrupted and ended with `[snippet]`. Continue from where you left off." |
| Steer around bad refusals | Not needed on 4.6+; refusals are appropriately calibrated. |

Prefills on earlier assistant turns (not the last one) still work.

## Image coordinates are 1:1

On Opus 4.8, image pointing and bounding-box coordinates are 1:1 with actual image pixels. This is the convention 4.7 introduced (4.6 and earlier used a scale-factor conversion). Remove any client-side coordinate transforms when consuming pointing or bounding boxes.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Breaking changes > Image coordinates.

## Sampling parameters and tokenizer

Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error on Opus 4.8, the same as on 4.7. The SDK request types still define these fields for compatibility with earlier models, so code that sets them type-checks, but the API rejects the request server-side. If you removed these parameters when migrating to 4.7, no further changes are needed.

Opus 4.7 introduced a different tokenizer than 4.6; 4.8 carries it forward. If you are coming from 4.6 or earlier, re-baseline end-to-end cost and latency and re-tune any client-side token-count estimations.

Source: https://docs.claude.com/en/docs/about-claude/models/migration-guide.md > Migrating from Claude Opus 4.7 to Claude Opus 4.8.

## Interactive vs autonomous coding

4.8 uses more tokens in interactive (multi-turn) coding sessions because it reasons more after each user turn. This improves long-horizon coherence, instruction following, and coding capability; it also costs more tokens.

**To maximize performance and token efficiency:**

1. Use `xhigh` or `high` effort.
2. Reduce required user interactions; add an auto mode if your product allows.
3. Specify task, intent, and constraints upfront in the first user turn. 4.8 is more autonomous than prior models, so a well-specified first turn maximizes autonomy and intelligence. Ambiguous prompts spread across multiple turns reduce both efficiency and performance.

Source: https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-4-8.md > Interactive coding products.

## Long-horizon and context awareness

4.8 tracks remaining context window (inherited from the 4.6/4.5 generation). To make use of it:

```text
Your context window will be automatically compacted as it approaches its limit, allowing you to continue working indefinitely from where you left off. Do not stop tasks early due to token budget concerns. As you approach your token budget limit, save your current progress and state to memory before the context window refreshes. Always be as persistent and autonomous as possible and complete tasks fully, even if the end of your budget is approaching. Never artificially stop any task early regardless of the context remaining.
```

Pair with the memory tool or filesystem state files (`progress.txt`, `tests.json`). Source: https://docs.claude.com/en/docs/build-with-claude/compaction.md > Context awareness pattern.

## Sonnet 4.6 quick deltas

If your prompt targets `claude-sonnet-4-6` instead of Opus 4.8:

- Default effort is `high` (Sonnet 4.5 had no effort param). Set explicitly to avoid latency.
- `medium` for most applications, `low` for high-volume or latency-sensitive workloads.
- 64k `max_tokens` recommended at `medium`/`high`.
- Use Opus 4.8 instead for the hardest, longest-horizon problems (large code migrations, deep research, extended autonomous work). Sonnet 4.6 is for fast, cost-efficient workloads.
- Sonnet 4.6 context window: 1M tokens (per `https://docs.claude.com/en/docs/about-claude/models/overview.md`).

Source: https://docs.claude.com/en/docs/about-claude/models/overview.md and https://docs.claude.com/en/docs/build-with-claude/adaptive-thinking.md.

## Haiku 4.5 quick deltas

`claude-haiku-4-5-20251001` is for latency-sensitive and high-throughput pipelines.

- 64k `max_tokens`.
- Context window: 200k tokens (smaller than Opus 4.8 and Sonnet 4.6's 1M).
- Use `medium` or `low` effort.
- **Thinking shape on Haiku 4.5 differs from Opus 4.8.** Haiku 4.5 accepts manual extended thinking (`thinking: {type: "enabled", budget_tokens: N}`); it does NOT accept adaptive thinking. If you are sharing a prompt path between models, branch on model ID and use the right shape per side.

Source: https://docs.claude.com/en/docs/about-claude/models/overview.md (latest-models comparison table, "Extended thinking" and "Adaptive thinking" rows).

## Computer use

Computer use works up to 2576px / 3.75MP resolution. 1080p is the sweet spot for performance and cost. 720p or 1366x768 for cost-sensitive workloads.

Source: https://docs.claude.com/en/docs/agents-and-tools/tool-use/computer-use-tool.md.

## Quick checklist for Opus 4.8 prompts

- [ ] `thinking: { type: "adaptive" }` set explicitly when thinking is wanted (off otherwise; not `enabled` + `budget_tokens`).
- [ ] `effort` set explicitly; `xhigh` for coding/agentic, `high` for intelligence-sensitive.
- [ ] `max_tokens` 64k at `xhigh`/`max`.
- [ ] Scope stated once where a rule must span ("apply to every X, not just the first"); no blanket "for each" reinforcement.
- [ ] No "CRITICAL / MUST / ALWAYS" wording on tool use.
- [ ] No prefill on the last assistant turn.
- [ ] No image-coordinate scale-factor math.
- [ ] No "after every N tool calls, summarize" scaffolding; 4.8 self-reports progress.
- [ ] Verbosity tuned with positive examples, not "do not be verbose."
- [ ] Frontend brief includes concrete spec or propose-then-pick.
- [ ] Code-review harness uses coverage-first or explicit severity bar.
