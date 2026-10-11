# Haiku 5.5 Tuning

What changed for `claude-haiku-5-5` (released 2026-10-07) relative to Haiku 4.5. Anthropic documents the move as light on prompts: Haiku 4.5 prompts work unchanged, so the Haiku 4.5 section of `opus-5-tuning.md` stays the baseline for Bedrock, Vertex, Foundry and Claude Platform on AWS (where `haiku` still resolves to 4.5) and this file wins everywhere else. Anthropic positions 5.5 as "a subagent on coding work" alongside Opus 5.5 and Sonnet 5.5, and keeps those two as the better choice for complex agentic coding.

Primary sources (raw markdown via the `.md` suffix, all fetched 2026-10-12):

- Haiku 5.5 overview: https://platform.claude.com/docs/en/models/haiku-5-5/overview
- What's new in Claude Haiku 5.5: https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5.md
- Effort: https://platform.claude.com/docs/en/build-with-claude/effort.md
- Prompting Claude Haiku 5.5: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5.md
- Announcement and benchmarks: https://www.anthropic.com/claude-haiku-5-5
- Claude Code model configuration: https://code.claude.com/docs/en/model-config.md

## Delta table

| Knob | Haiku 4.5 | Haiku 5.5 | Prompt author action |
|---|---|---|---|
| ID | `claude-haiku-4-5-20251001` | `claude-haiku-5-5`, no dated snapshot (a dateless ID is pinned) | Pin by ID only where a measured behaviour must not drift. |
| Effort | unsupported | First Haiku with it: `low`, `medium`, `high`, `xhigh`, `max`; default `medium` on the API and in Claude Code | Set `effort` explicitly; drop any "this model has no effort" branch for 5.5. |
| Thinking | manual `budget_tokens` only; adaptive rejected | Adaptive is the default; manual `enabled` + `budget_tokens` returns an error; `disabled` accepted at `high` or below, 400 at `xhigh` / `max` | Omit `thinking`. Branch on model ID where one path serves both. `between_tools` is documented for Sonnet 5.5 only; not verified for Haiku. |
| Thinking text | not covered here | Omitted unless `thinking.display: "summarized"` | Set `display` when a UI renders it. |
| Prefill | not covered here | Assistant prefill errors | Use `output_config.format` or an XML wrap. |
| Sampling | not covered here | `temperature` / `top_p` / `top_k` can return 400 (exact values not verified) | Leave them unset. |
| Context, output | 200k, 64k | 1M, 128K (300K on Batch with `output-300k-2026-03-24`) | |
| Tokenizer | baseline | About 30% more tokens for the same text | Re-baseline token estimates and any `max_tokens` carried over from 4.5. |
| Cache minimum | 4,096 tokens | 512 tokens | Short static prompts now cache. |
| Pricing in / out per MTok | $1 / $5 | $0.10 / $0.50 up to 100k-token prompts, $0.50 / $2.50 above; cache 5m write $0.125, 1h write $0.20, read $0.01 (x5 above 100k); batch 50% | |
| Knowledge cutoff | not covered here | June 2026 | |
| Retirement | not before 2026-10-15 | not before 2027-10-07 | |

## Effort

"Start at medium" is Anthropic's advice, including for agentic coding. Use `low` for chat and short tool tasks, and `high` for knowledge work, longer agent tasks and strict instruction following; reach for `xhigh` or `max` only where evals show a gain, and compare against Sonnet 5.5 there. At `low` in a long agent prompt it skips a search, stops early or skips a check, so every level below `medium` on agent work needs the two paragraphs below. At `xhigh` in a multi-turn chat the reply can come back empty; treat an empty `content` as a retry or step the level down.

Asking it to "answer directly" does not stop the thinking. Lower the effort instead.

## Early stopping in long agent prompts

Anthropic's measurement: going from `low` to `medium` roughly halved early stopping and more than doubled output tokens, so the level is a cost choice as much as a quality one. For long agent prompts, add a paragraph in this shape (a starting draft built from the guide's description, not Anthropic's verbatim text):

```text
Keep working until everything the user asked for is done. Do not stop after the first part of a multipart task, and do not ask whether to continue unless you cannot go on without the user or the next step is risky. When the work is done and checked, stop and report.
```

In a subagent body, name the early stops the orchestrator expects (a briefing gap, a contradiction, a tier mismatch, a blocker) so the paragraph does not swallow them. Claude Code adds a section of this kind to a Haiku 5.5 main thread itself; see the last section.

## Verification at `low` and `medium`

Add a verify-before-done paragraph when the agent edits code at these levels (draft in the same spirit, not verbatim):

```text
Before reporting a change as done, run a real check that exercises it: the project's tests, type-checker or build, or the changed command. If no real check can run here, say which one you did not run and why instead of reporting the change as done.
```

## Search and the date

When a search tool is available, give the current date in the prompt.

## Mid-turn messages, JSON and refusals

- Deliver mid-turn user text as a user turn after the last `tool_result`, never inside a `tool_result`.
- When combining JSON output with your own tools, use adaptive thinking (leave `thinking` unset).
- Refusals are possible and arrive as `stop_reason: "refusal"`; a client that handles only `end_turn` and `max_tokens` needs the branch.

## Benchmarks

From the announcement page, read through a garbled extraction (digit splits inferred), so re-read the page before quoting. Haiku 5.5 / Haiku 4.5 / Sonnet 5.5: FrontierCode 1.1 Main 46.4% / not listed / 52.1% (Sonnet at `xhigh`); Terminal-Bench 4.0 39.2% / 0.0% / 70.6%; OSWorld 2.1 72.4% / 15.7% / 83.9%. No SWE-bench figure is published for Haiku 5.5 and none is quoted here.

## Inside Claude Code 2.1.296

Read off the 2.1.296 binary on 2026-10-12 and the model configuration page. Capabilities can be served remotely, so re-read a session jsonl before relying on any of this.

- `model: haiku` resolves to `claude-haiku-5-5` on the Anthropic API and to Haiku 4.5 on Bedrock, Vertex, Foundry and Claude Platform on AWS, where effort stays unsupported. Haiku 5.5 needs Claude Code 2.1.293 or later. `ac:explore` subagents in the 2026-10-12 session ran `claude-haiku-5-5` (subagent jsonl `message.model`).
- Baked default effort is `medium`. A subagent without an `effort:` key inherits the session level (Claude Code sub-agents docs, "Overrides the session effort level"); the level a Haiku agent actually ran at was not measured.
- It gets the LEAN system prompt (capability `lean_prompt`), as the other models on the roster below do. Every earlier Haiku got CLASSIC, so the classic-only rules (no speculative abstraction, no impossible fallback, no compat shim, prefer editing an existing file, never guess a URL, flag prompt injection) no longer reach a Haiku 5.5 main thread.
- LEAN roster on 2.1.296: `claude-sonnet-5-5`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5-1`, `claude-haiku-5-5`, plus `claude-mythos-5` by an explicit name check.
- A `haiku_5_5_early_stopping_guidance` capability adds a main-thread system-prompt section that opens "The reasoning effort setting changes how much you think before you act. It does not change how much of the request you are expected to finish ...". A subagent's system prompt is its agent body, so a Haiku 5.5 subagent does not get it (inference, not measured).
- Haiku 5.5 caps in the binary: window 1,000,000, max output 128,000, effort through `max`, adaptive thinking, per-turn effort. Haiku 4.5: window 200,000, no effort.

## Checklist for a Haiku 5.5 prompt

- [ ] `effort` set explicitly, starting at `medium`; `low` only for chat and short tool tasks.
- [ ] `thinking` omitted or adaptive; no manual `budget_tokens`, and no `disabled` at `xhigh` / `max`.
- [ ] A branch on model ID wherever one path also serves Haiku 4.5 (manual thinking, no effort).
- [ ] Long agent prompts at `low` / `medium`: the keep-working paragraph with expected early stops named, and the verify-before-done paragraph.
- [ ] No "answer directly" line used as a thinking control.
- [ ] Current date given when a search tool is available.
- [ ] No prefill, no non-default sampling parameters; `max_tokens` and token estimates re-baselined for the tokenizer.
- [ ] User text never inside a `tool_result`; refusals handled.
