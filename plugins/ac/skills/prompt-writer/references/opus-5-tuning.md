# Opus 5 Tuning

Specific, load-bearing knobs for `claude-opus-5` (released 2026-07-24). Read this when writing or debugging a prompt for Opus 5, or when tuning a prompt up from Opus 4.8, 4.7, or Sonnet 5.

Primary sources (raw markdown via the `.md` suffix on `platform.claude.com`):

- Prompting Claude Opus 5: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md
- What's new in Claude Opus 5: https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md
- Migration guide: https://platform.claude.com/docs/en/about-claude/models/migration-guide.md
- Effort: https://platform.claude.com/docs/en/build-with-claude/effort.md
- Thinking, steering and cost: https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost.md
- Models overview: https://platform.claude.com/docs/en/about-claude/models/overview.md
- Prompt engineering best practices: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md

## Why this matters

Opus 5 runs existing Opus 4.8 prompts without API changes beyond the thinking default. But three defaults moved, and two of them moved in the OPPOSITE direction from 4.8. A prompt carefully tuned for 4.8 now overcorrects on Opus 5: it pushes for length the model already produces, and it pushes for fan-out the model already does. Read the inversion table first; it is where most 4.8-era prompts now fight the model instead of steering it.

## What inverted from 4.8 (read this first)

| Behavior | Opus 4.8 | Opus 5 | What to do |
|---|---|---|---|
| Verbosity | Self-calibrates to perceived task complexity | Default user-facing responses run LONGER than prior Opus models, and effort does not reliably shorten them | State an explicit length target. Effort is no longer the verbosity lever. |
| Subagent spawning | Spawns fewer subagents unprompted | Delegates to subagents MORE readily than prior models | Say when NOT to spawn. Drop 4.8-era "spawn multiple subagents when fanning out" encouragement. |
| Thinking | Off unless you set `{"type": "adaptive"}` | On by default | Remove the explicit enable. To disable, see the effort cap below. |

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Response length and verbosity, Controlling subagent spawning; and https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md > Thinking on by default.

## Effort and thinking depth

Five levels, default `high`, same ladder as 4.8. What changed is how reliably effort pays off: "Claude Opus 5 converts additional effort into better results more reliably than any earlier Opus model."

Source: https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md > Effort matters more.

| Effort | Use for | What Opus 5 does |
|---|---|---|
| `max` | Hardest, intelligence-demanding tasks | Maximum reasoning. Still subject to diminishing returns; test before committing. |
| `xhigh` | Coding, agentic loops, long-horizon work | Best setting for most coding and agentic use cases. |
| `high` | Intelligence-sensitive non-coding work | The default. Balances tokens and intelligence. |
| `medium` | Cost-sensitive work | Scopes work closer to what was asked. |
| `low` | Short scoped tasks, latency-critical | Aggressive scoping. Reserve for simple lookups. |

**Effort is not a length lever on Opus 5.** On 4.8, dropping to `low` or `medium` scoped the work down and shortened output as a side effect. On Opus 5, "changing effort does not reliably shorten responses". If you want shorter output, ask for it directly (see Response length below).

**Token budget.** At `xhigh` or `max`, set `max_tokens` to roughly 64k, more if you want headroom under the 128k ceiling. Maximum output: Opus 5, Sonnet 5, and Fable 5 are all 128k; Haiku 4.5 is 64k.

Source: https://platform.claude.com/docs/en/about-claude/models/overview.md (latest-models comparison table, "Max output" row).

**Prompt fallback for low effort.** If latency forces `low`:

```text
This task involves multi-step reasoning. Think carefully through the problem before responding.
```

## Thinking

Thinking is ON by default on Opus 5. This is the breaking change from 4.8, where thinking was off unless you asked for it. The wire value is unchanged: `thinking: {"type": "adaptive"}` remains valid and is equivalent to the default, so an existing 4.8 integration keeps working; the explicit enable is now redundant rather than required.

Manual extended thinking is still rejected. `thinking: {"type": "enabled", budget_tokens: N}` returns a 400 error on Opus 4.7, Opus 4.8, Opus 5, and Sonnet 5.

```python
client.messages.create(
    model="claude-opus-5",
    max_tokens=64000,
    # thinking={"type": "adaptive"},  # redundant on Opus 5; this is the default
    output_config={"effort": "high"},  # max, xhigh, high, medium, low
    messages=[{"role": "user", "content": "..."}],
)
```

**Disabling thinking is capped by effort.** `thinking: {"type": "disabled"}` returns a 400 error at effort `xhigh` or `max`. Disable only at `high` or below. This constraint is new in Opus 5.

Source: https://platform.claude.com/docs/en/about-claude/models/migration-guide.md > Migrating from Claude Opus 4.8 to Claude Opus 5, and https://platform.claude.com/docs/en/build-with-claude/extended-thinking.md > Migrating to adaptive thinking.

**Running with thinking disabled has artifacts.** The Opus 5 prompting page documents two failure shapes when thinking is off: tool calls leaking into the text response, and stray XML tags in output. If a product needs thinking off, budget for mitigation prompting rather than assuming clean output.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Running with thinking disabled.

**Display thinking content.** When the UI renders thinking:

```json
{"type": "adaptive", "display": "summarized"}
```

Other models: manual extended thinking is the only supported shape on Haiku 4.5 (adaptive is not accepted there). On Sonnet 5, adaptive is default-on and manual is removed, not merely deprecated.

## Response length and verbosity

Opus 5 responses run longer than prior Opus models by default, and unlike 4.8 the length does not track perceived task complexity as tightly. Effort will not fix it.

**Ask positively, with a target:**

```text
Provide concise, focused responses. Lead with the answer in one or two sentences, then at most three supporting points. Skip non-essential context.
```

**Positive examples beat negative instructions.** Show one short response you like rather than writing "do not be verbose." The model maps to the example.

**Written deliverable length is a separate concern.** The Opus 5 page treats the length of a produced artifact (a document, a report, a spec) as distinct from chat verbosity. A prompt that caps conversational length does not cap deliverable length; state the deliverable's target separately when it matters.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Response length and verbosity, Written deliverable length.

## Task scope and over-verification

New behavior with no 4.8 equivalent: Opus 5 can expand a task's scope on its own and over-verify work that was already verified. This is the flip side of higher autonomy.

State the boundary rather than trusting the ask to hold it:

```text
Change only the files listed above. If you find an adjacent problem, report it in one line at the end; do not fix it in this task.

Verify once: run the test command and report the result. Do not re-run passing checks to build confidence.
```

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Task scope and over-verification.

## Subagent spawning

Opus 5 delegates to subagents more readily than prior models. The 4.8-era encouragement snippet ("spawn multiple subagents in the same turn when fanning out") now pushes an already-eager default and produces delegation for work the model could finish inline.

Invert the steering:

```text
Complete work directly when you can already see what needs to change. Spawn a subagent only when the work needs a separate context window: broad multi-file search, or research whose raw output you will not need again.
```

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Controlling subagent spawning.

## User-facing progress updates and self-correction

Opus 5 provides interim updates natively through long agentic traces, same as 4.8. Old scaffolding like "after every 3 tool calls, summarize progress" overtriggers without improving the updates; remove it.

Opus 5 additionally narrates self-correction. When the model revises its own approach mid-task, it says so. If that reads as churn in your product surface, describe the update style you want with an example rather than suppressing the narration wholesale.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > User-facing progress updates, Self-correction.

## Code review harnesses may need re-tuning

Unchanged from 4.8, and restated near-verbatim on the Opus 5 page: "If your review prompt says 'only report high-severity issues' or 'be conservative,' the model may follow that instruction literally and report less; ask it to report everything and filter in a separate pass instead."

**Fix.** Move filtering downstream. Tell the model its job is coverage:

```text
Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage; a separate verification step will do that. For each finding, include your confidence level and an estimated severity so a downstream filter can rank them.
```

If you want self-filtering in a single pass, be concrete about the bar:

```text
Report any bugs that could cause incorrect behavior, a test failure, or a misleading result. Only omit nits like pure style or naming preferences.
```

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5.md > Capability improvements.

## Unchanged from 4.8

Do not re-litigate these when porting a 4.8 prompt. Each is confirmed still current on Opus 5 by the migration guide.

| Item | Behavior |
|---|---|
| Sampling parameters | Non-default `temperature`, `top_p`, or `top_k` returns a 400 error. |
| Prefill | Prefilling the last assistant message returns a 400 error (since 4.6). Prefills on earlier assistant turns still work. |
| Tokenizer | Identical to 4.8. No re-baselining needed when moving 4.8 to 5. |
| Context window | 1M tokens. |
| Max output | 128k tokens. |
| Image coordinates | 1:1 with actual image pixels. No client-side scale factor. High-res handling at 2,576px long edge. |
| Pricing | $5 per MTok input, $25 per MTok output, unchanged from 4.8. |
| Effort default | `high`, five levels. |

Source: https://platform.claude.com/docs/en/about-claude/models/migration-guide.md > Migrating from Claude Opus 4.8 to Claude Opus 5, and https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md > Pricing.

Prefill migration paths, unchanged:

| Old prefill use | Migration |
|---|---|
| Force JSON / YAML output | Structured Outputs (`output_config={"format": {...}}`) |
| Force classification label | Tool call with enum, or Structured Outputs |
| Skip preamble | Direct instruction: "Respond directly without preamble. Do not start with 'Here is...' or 'Based on...'" |
| Continue interrupted response | New user message: "Your previous response was interrupted and ended with `[snippet]`. Continue from where you left off." |

## Net-new API surface in Opus 5

- **Mid-conversation tool changes** (beta): the tool list can change mid-conversation while preserving the prompt cache.
- **`fallbacks` parameter**, defaulting to `"default"`.
- **Lower prompt-cache minimum**: 512 tokens, down from 1,024 on 4.8. Short system prompts that could not be cached before now can.
- **Fast mode** (research preview, Claude API only): $10 per MTok input, $50 per MTok output.

Source: https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md > New features.

## Gaps: verify before asserting

Two behaviors documented for 4.8 have NO Opus 5 statement, positive or negative. Test them in your own harness rather than carrying the 4.8 claim forward under an Opus 5 label.

- **Tool-use conservatism.** The 4.8 page had a dedicated "Tool use triggering" section stating the model favors reasoning over tool calls. The Opus 5 page has no equivalent section. The only adjacent signal is a vision-context note that "tool use is a more cost-effective lever than thinking alone", which does not generalize. Given that Opus 5 inverted BOTH verbosity and subagent spawning toward more output and more delegation, an inversion here is plausible, but it is not documented.
- **Frontend and design defaults.** The 4.8 page described a persistent house style (warm cream backgrounds around `#F4F1EA`, serif display fonts, terracotta accents) and the two prompting strategies that break it. The Opus 5 prompting page has no design-defaults section at all. Whether the house style persists, shifted, or was removed is undocumented.

The two strategies that worked on 4.8 for design control are model-agnostic and still worth using regardless: give a concrete spec (hex codes, named typeface, layout structure), or have the model propose several directions and let the user pick one before building.

## Sonnet 5 deltas

If your prompt targets `claude-sonnet-5` instead of Opus 5:

- Default effort `high`, all five levels supported. Set explicitly when you want something other than `high`.
- Adaptive thinking is default-on; you do not need to set `thinking` at all. Manual `{"type": "enabled", budget_tokens: N}` is removed and returns a 400 error, not a soft deprecation.
- Non-default `temperature` / `top_p` / `top_k` return a 400 error, same as Opus 5. This landed on Sonnet-class models with Sonnet 5; it was introduced on Opus 4.7.
- 1M context window (default and maximum; there is no smaller variant), 128k max output.
- Tokenizer: the docs state roughly 30% more tokens than Sonnet 4.6 for equivalent text. They do NOT state that it is the same tokenizer generation as Opus 4.7/4.8; treat any such equivalence as an inference, not a documented fact. Re-baseline token-count estimates carried over from Sonnet 4.6.
- Pricing $3 per MTok input, $15 per MTok output (introductory $2/$10 through 2026-08-31).
- Knowledge cutoff January 2026, versus Opus 5's May 2026.
- Reach for Opus 5 on the hardest, longest-horizon problems. Sonnet 5 is the fast, cost-efficient default for everything else.

Source: https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5.md and https://platform.claude.com/docs/en/about-claude/models/overview.md.

## Haiku 4.5 deltas

`claude-haiku-4-5-20251001` is for latency-sensitive and high-throughput pipelines. There is no Haiku 5.

- **The `effort` parameter is not supported at all.** Haiku 4.5 is absent from the effort-supported model list; do not set effort for it and do not describe it as a "low effort" model. Scope its work through the prompt instead.
- **Thinking shape is inverted relative to the Claude 5 family.** Haiku 4.5 accepts manual extended thinking (`{"type": "enabled", budget_tokens: N}`) and does NOT accept adaptive thinking. When sharing a prompt path across models, branch on model ID and use the right shape per side.
- 200k context window, 64k max output.
- Pricing $1 per MTok input, $5 per MTok output.
- Knowledge cutoff February 2025, the oldest in the current roster.

Source: https://platform.claude.com/docs/en/build-with-claude/effort.md (supported-model list) and https://platform.claude.com/docs/en/about-claude/models/overview.md.

## Fable 5 and Mythos 5 (above Opus 5)

`claude-fable-5` sits above Opus 5: Anthropic describes it as their most capable widely released model, built for the most demanding reasoning and long-horizon agentic work.

- 1M context, 128k max output, all five effort levels with default `high`.
- Thinking is always on and cannot be disabled.
- Pricing $10 per MTok input, $50 per MTok output, twice Opus 5, with slower latency.
- Adds refusal-capable safety classifiers: a refusal arrives as `stop_reason: "refusal"` with HTTP 200, not an error, plus `fallbacks` and prompt-cache-refund billing mechanics on refusal. A client that only handles `end_turn` and `max_tokens` needs a new branch.
- Knowledge cutoff January 2026.

`claude-mythos-5` is a limited-availability sibling sharing Fable 5's specs and pricing without the safety classifiers. A `claude-mythos-preview` model is deprecated.

The official framing is a general reasoning and agentic flagship, not a coding-specialized or creative-writing-specialized model; third-party claims of a creative-writing niche are not corroborated by Anthropic pages. For a coding tier ladder, treat Fable 5 as an optional top tier above Opus 5 for the hardest agentic work, gated by its price and latency, rather than a default.

Source: https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5.md and https://platform.claude.com/docs/en/about-claude/models/overview.md.

## Model roster and deprecation status

| Model | ID | Context | Max output | Effort | Thinking | Price in/out per MTok |
|---|---|---|---|---|---|---|
| Fable 5 | `claude-fable-5` | 1M | 128k | 5 levels, default `high` | adaptive, always on | $10 / $50 |
| Opus 5 | `claude-opus-5` | 1M | 128k | 5 levels, default `high` | adaptive, default on | $5 / $25 |
| Sonnet 5 | `claude-sonnet-5` | 1M | 128k | 5 levels, default `high` | adaptive, default on | $3 / $15 (intro $2 / $10 to 2026-08-31) |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | 200k | 64k | not supported | manual only | $1 / $5 |

Opus 4.8, 4.7, 4.6, 4.5 and Sonnet 4.6, 4.5 remain Active with no deprecation date. Tentative earliest retirements: `claude-opus-4-8` not sooner than 2027-05-28, `claude-sonnet-5` not sooner than 2027-06-30, `claude-haiku-4-5-20251001` not sooner than 2026-10-15.

Source: https://platform.claude.com/docs/en/about-claude/model-deprecations.md.

## Quick checklist for Opus 5 prompts

- [ ] No explicit `thinking: {"type": "adaptive"}` enable; it is the default (harmless if present, just redundant).
- [ ] No `thinking: {"type": "disabled"}` paired with effort `xhigh` or `max` (400 error).
- [ ] No manual `{"type": "enabled", budget_tokens: N}` (400 error).
- [ ] `effort` set explicitly when the task needs something other than `high`; `xhigh` for coding and agentic work.
- [ ] `max_tokens` around 64k at `xhigh` or `max`.
- [ ] Length controlled by an explicit target, not by lowering effort.
- [ ] Deliverable length stated separately from conversational length when it matters.
- [ ] Scope boundary stated (Opus 5 can expand scope and over-verify on its own).
- [ ] Subagent steering says when NOT to spawn; no 4.8-era fan-out encouragement.
- [ ] No "after every N tool calls, summarize" scaffolding.
- [ ] No prefill on the last assistant turn; no non-default sampling parameters.
- [ ] No image-coordinate scale-factor math.
- [ ] Code-review harness uses coverage-first or an explicit severity bar.
- [ ] Thinking shape matches the model: default-on adaptive on Opus 5 / Sonnet 5 / Fable 5; manual-only on Haiku 4.5.
- [ ] No `effort` set for Haiku 4.5 (unsupported).
- [ ] Output shape locked via `output_config.format`, a tool call with an enum, or an XML wrap.
