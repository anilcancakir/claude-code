# Sonnet 5.5 Tuning

The card for `claude-sonnet-5-5` (released 2026-09-28). Read `claude-models.md` first for what all three 5.5 models share; this file holds what is Sonnet-specific. Labels: Doc, Carried, Host, Measured, Inference, as defined there. Anthropic: "For the hardest long-horizon work, an Opus model is the better choice."

Start here:

1. Set `effort` yourself: `high` is the API default, `medium` the Claude Code default. Agentic coding starts at `medium` for well-specified tasks and `high` for harder ones.
2. At `low` and `medium` it checks in before a long task is done: raise effort first, or add the keep-working paragraph.
3. At every level it adds tests, docs and small files; at `xhigh` and `max` it starts its own review rounds. Add the scope paragraphs if that costs you.
4. For JSON answers that need working out, use adaptive thinking and "Think the problem through before you answer."
5. Never put user text inside a `tool_result`.

Primary sources, fetched 2026-11-23:

- Prompting Claude Sonnet 5.5: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5.md
- What's new in Sonnet 5.5: https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5.md
- Effort, "Recommended effort levels": https://platform.claude.com/docs/en/build-with-claude/effort.md

## Knobs (Doc)

| Knob | Sonnet 5.5 | Prompt author action |
|---|---|---|
| Effort | `high` on the API, `medium` in Claude Code. "a level doesn't produce the same amount of thinking as the same level on Claude Sonnet 5" | Fresh sweep. Chat and latency-sensitive work: `medium` or `low`. `xhigh` and `max` only on a measured gain. |
| Thinking | Adaptive. `disabled` returns 400; `between_tools` is the lowest setting, accepted at `low`, `medium` and `high`, and takes no other field | `between_tools` or omit `thinking`; see below. |
| Forced tool use | `any` and `tool` return 400, also on token counting | `auto` plus a prompt line, or Structured Outputs. |
| `max_tokens` | 128,000 for agentic coding, streamed | Thinking counts toward it. |
| Safeguards | `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`; server-side fallback retries `cyber` and `frontier_llm` on Sonnet 5 only | Handle `stop_reason: "refusal"`; `bio` has no fallback. |
| Cache read | $0.10 | |

## Initiative and scope (Doc)

How far it goes on its own depends on effort and the request.

**Carrying work through.** At `low` and `medium` on agentic coding it "might pause to confirm a plan, ask a question it could answer itself, or stop after one part of a multipart task to ask whether to continue." Try a higher level first. To keep the level, add:

```text
Keep working until everything the user asked for is done, and only stop to ask when you can't go on without the user or before a risky step.

When the work the user asked for is done and checked, stop and report. Don't add features, tests, files, docs, or refactors that weren't asked for. If you think one would help, mention it at the end instead of doing it.
```

Sessions then run longer and cost more. It does not replace your own rules for risky or irreversible actions. In a subagent body, name the early stops the orchestrator does expect (a briefing gap, a contradiction, a blocker) so the paragraph does not swallow them (Inference).

**Unrequested additions.** At every level, more at higher effort, it "tends to add tests, documentation, and small supporting files that fit your repository's conventions", while the requested change stays close to the ask. To limit changes to what was requested, keep only the second paragraph above.

**Self-started review at `xhigh` and `max`.** "After it completes a task, it can start its own rounds of review and verification, sometimes with subagents if your harness provides them." Run routine work at `high` or below, or add:

```text
When the work the user asked for is done and its checks pass, stop and report. Don't start extra rounds of review or hardening on your own, and don't launch reviewer subagents unless the user asked for a review. If you think a deeper review is worth doing, say so at the end.
```

At `max` on coding tasks this stopped reviewer subagents and cut session cost by about a third with no quality change; it makes self-started rounds by the main agent rarer, not absent.

**Open-ended requests** can turn into a built artifact. Say "ideas or a plan first" in the request, or: "When the user asks for ideas, options, or a plan, give them that and stop. Don't start building or changing anything until they say to go ahead."

## Verification at `low` (Doc)

At `low` it "sometimes reports a change as done without running a check that exercises it." Use the verify paragraph in `claude-models.md`; Anthropic reports skipped or superficial checks become rare, with a slightly higher cost per task.

## Running without up-front thinking (Doc)

`thinking: {"type": "between_tools"}` is the setting for no up-front thinking, accepted at `high` effort or below (400 at `xhigh` and `max`). Per-message effort that differs from the level in effect returns 400 with it, so vary effort per turn with adaptive thinking. Remove any "do not think" rule: it makes internal XML tags more likely in the visible output. In a request without tools it means no thinking at all, so use adaptive thinking for reasoning tasks. Notes longer than a sentence or two still come back as `thinking` blocks; pass them back unchanged.

## JSON answers that need working out (Doc)

With Structured Outputs at `low` and `medium` it often answers without thinking and accuracy drops. Use adaptive thinking and add at the end of the system prompt: "Think the problem through before you answer." At `high` this gets close to `xhigh` accuracy; `xhigh` alone also works. Treat `stop_reason: "max_tokens"` as failed even when the JSON parses. Without Structured Outputs, parse the last JSON value in the `text` blocks, not the span from the first `{` to the last `}`.

## Search, progress updates, tool calls (Doc)

- **Search over training knowledge.** It "sometimes answers from its training knowledge when a web search would catch details that have changed." Remove "only use tools when strictly necessary" lines first, then: "Use the search tool to check specifics that may have changed since your training, such as what is allowed, required, or charged, even when you feel confident. For researched work such as a report or a comparison, gather current sources rather than writing from your training knowledge." A research agent needs this more than a coding one.
- **Progress updates.** Notes longer than a sentence or two come back as progress-update `thinking` blocks; with `between_tools` they carry their summary and no `display` field is needed. Remove "hold all findings for the final response". For long silent turns, append the turn-scoped reminder given in `opus-5-5-tuning.md` after five quiet steps and leave it in `messages` on later requests (that keeps the cache and preserved thinking intact); stop after the second or third. Frequent harness text after tool results can be read as injection.
- **Mid-turn messages.** It sometimes reads a genuine user message as an injection when it sits inside a `tool_result` or arrives as a system message right after one. Follow the shared rules; a token countdown after every tool result can cause it.
- **Tolerant tool calls.** It occasionally calls a tool by a name that differs only in letter case (`bash` for `Bash`) or passes a parameter under a near name. Accept an unambiguous match, or return `is_error: true` naming the exact expected name.
- **Visual inputs.** Give it a crop, zoom or code tool for dense charts and technical drawings; for charts, tools help at every effort level.

## Inside Claude Code (Host, 2.1.318)

- `model: sonnet` resolves to `claude-sonnet-5-5` on the Anthropic API; LEAN prompt; default effort `medium`; the `silent_turn_reminder` capability ("The user hasn't heard from you in a while ..." after five quiet turns): do not add your own progress scaffolding; no prompt bundle, so read a session snapshot before assuming Opus 5.5's host sections.
- A cyber-flagged request re-runs on Sonnet 5; a bio flag ends in a refusal.
- Measured: a Sonnet 5.5 code-review pass at `xhigh` returned 22 findings at $11.07 against 29 at $15.07 for Opus 5.5 at `high` (four plans, 2026-10-27), with about twice the output tokens and about 40% longer wall time. On four senior implementation steps Sonnet 5.5 at `xhigh` cost $5.14 against $5.07 for Opus 5.5 at `medium`, wrote 2 to 2.5 times the output, took about twice as long, and a blind reviewer preferred it on 3 of 4 (n=4). Both runs have Sonnet slower, by different amounts, and they disagree on quality (behind Opus in review, preferred on senior steps), so measure your own task.

## Checklist for a Sonnet 5.5 prompt

- [ ] The `claude-models.md` checklist passes.
- [ ] `effort` set explicitly by a fresh sweep, remembering `high` (API) against `medium` (Claude Code).
- [ ] `thinking` omitted, adaptive, or `between_tools` at `high` or below.
- [ ] Agentic work at `low` or `medium`: the keep-working paragraph with expected early stops named.
- [ ] Fixed scope: the no-unrequested-additions paragraph; routine work at `high` or below, or the no-self-review paragraph.
- [ ] Coding at `low`: the verify paragraph.
- [ ] JSON that needs working out: adaptive thinking plus "Think the problem through before you answer."
- [ ] Research and support prompts: the search paragraph and no line that discourages tool use.
- [ ] Conversation append-only; user text never inside a `tool_result`.
