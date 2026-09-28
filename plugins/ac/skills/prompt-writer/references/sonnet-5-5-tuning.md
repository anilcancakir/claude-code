# Sonnet 5.5 Tuning

What changed for `claude-sonnet-5-5` (released 2026-09-28) relative to Sonnet 5. Anthropic documents 5.5 as a delta: "Existing Claude Sonnet 5 prompts should perform well without changes, and the patterns in Prompting Claude Sonnet 5 remain a reasonable starting point." So the Sonnet 5 section of `opus-5-tuning.md` stays the baseline and this file wins wherever the two disagree. For the hardest long-horizon work Anthropic still points at Opus.

Primary sources (raw markdown via the `.md` suffix):

- Prompting Claude Sonnet 5.5: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5.md
- What's new in Claude Sonnet 5.5: https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5.md
- Effort, "Recommended effort levels for Claude Sonnet 5.5": https://platform.claude.com/docs/en/build-with-claude/effort.md
- System card (PDF): https://www-cdn.anthropic.com/870c8f525702625d2c62fc6dd04c857e3250bec1/Claude%20Sonnet%205.5%20System%20Card.pdf

## Delta table

| Knob | Sonnet 5 | Sonnet 5.5 | Prompt author action |
|---|---|---|---|
| Default effort | `high` | `high` on the API, `medium` in Claude Code | Set `effort` explicitly; the two surfaces disagree. |
| Effort per label | baseline | Recalibrated: "a level doesn't produce the same amount of thinking as the same level on Claude Sonnet 5" | Re-sweep. Agentic coding starts at `medium` for well-specified tasks, `high` for harder or longer ones; chat at `medium` or `low`. `xhigh` / `max` only on a measured gain. |
| Thinking off | `disabled` accepted | `disabled` returns 400; `between_tools` is the lowest setting, accepted at `low` to `high` only, and takes no other field | Send `between_tools`, or omit `thinking` for adaptive. Manual `budget_tokens` stays 400. |
| Thinking depth | adaptive | From `medium` up it "thinks briefly before almost every reply, even a greeting"; a system-prompt request to think less "doesn't reliably reduce its thinking" | Lower effort, not prose. |
| Forced tool use | accepted | `any` / `tool` return 400, also on token counting | `auto` plus `strict: true`, or Structured Outputs. |
| Thinking-block binding | none | Blocks are tied to the model and, for accounts created on or after 2026-08-31, to an unchanged prefix | Keep the conversation append-only; late rules go in a mid-conversation system message. |
| Text between tool calls | `text` blocks | Notes longer than a sentence or two come back as progress-update `thinking` blocks, empty at the default `display` | Harness concern: `display: "updates"` (beta), or `between_tools`, which returns them with their summary. |
| Safeguards | cyber | Adds `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`; server-side fallback retries only `cyber` and `frontier_llm`, on Sonnet 5 | Do not ask for reasoning in the reply. |
| `max_tokens` | 64k default | 128,000 for agentic coding, streamed | Thinking counts toward it even when not returned. |
| Pricing | $2 / $10 (the launch price became standard) | $2 / $10, cache read $0.20, 5m write $2.50, 1h write $4 | |
| Context, output, cutoff | 1M, 128k, January 2026 | 1M, 128k, June 2026 | |

Unchanged and restated on the 5.5 overview page: non-default `temperature` / `top_p` / `top_k` return 400.

## Initiative and scope

The two failure modes sit at opposite ends of the effort range, so the fix depends on the level you run.

**Early check-ins at `low` and `medium`.** "It might pause to confirm a plan, ask a question it could answer itself, or stop after one part of a multipart task to ask whether to continue." Try a higher level first. To keep the level, Anthropic's system-prompt paragraph:

```text
Keep working until everything the user asked for is done, and only stop to ask when you can't go on without the user or before a risky step. When the work the user asked for is done and checked, stop and report. Don't add features, tests, files, docs or refactors that weren't asked for. If you think one would help, mention it at the end instead of doing it.
```

Sessions then run longer and cost more at those levels. The paragraph does not replace your own rules for risky or irreversible actions. In a subagent body, name the early stops the orchestrator does expect (a briefing gap, a contradiction, a tier mismatch, a blocker it cannot clear) so the paragraph does not swallow them.

**Unrequested additions at every level.** The model "tends to add tests, documentation, and small supporting files that fit your repository's conventions," more at higher effort, while the requested change stays close to the ask. Where scope is fixed by a file list or a reviewer that penalises extra diff, keep only the second paragraph above ("When the work the user asked for is done ...").

**Self-started review at `xhigh` and `max`.** "After it finishes a task, it can start its own rounds of review and verification, sometimes with subagents if your harness provides them." Run routine work at `high` or below. To keep the level:

```text
When the work the user asked for is done and its checks pass, stop and report. Don't start extra rounds of review or hardening on your own, and don't launch reviewer sub-agents unless the user asked for a review. If you think a deeper review is worth doing, say so at the end.
```

At `max` on coding tasks this stopped the reviewer subagents and cut session cost by about a third with no quality change. The system card records the same shape on FrontierCode v1.1: 52.1% Main at `xhigh`, 46.2% at `max`, on a benchmark that penalises out-of-scope changes.

**Open-ended requests** ("show me what you can do with this") can turn into a built artifact. Say "ideas or a plan first" in the request or the system prompt.

## Verification at `low`

At `low` it "sometimes reports a change as done without running a check that exercises it." Anthropic's paragraph, for any coding agent run at `low`:

```text
When you change code that can be run, built, or type-checked, run a real check that exercises the change before reporting it done: the project's tests, type-checker, or build, or the changed command itself. A syntax-only check, or a check command that failed to start, does not count; if all that is missing is the project's declared dependencies, install them with its own package manager and lockfile (e.g. npm install, pip install -r requirements.txt), never via sudo or the system package manager, unless told not to. Only if no real check can run here, say which one you did not run and why instead of reporting the change as done.
```

## Search over training knowledge

On chat and knowledge work it "sometimes answers from its training knowledge when a web search would catch details that have changed." Remove "only use tools when strictly necessary" or "minimize tool calls" lines first, then:

```text
Use the search tool to check specifics that may have changed since your training, such as what is allowed, required or charged, even when you feel confident. For researched work such as a report or a comparison, gather current sources rather than writing from your training knowledge.
```

A research agent needs this more than a coding one; a hard search ceiling is fine, a line that discourages searching is not.

## JSON answers that need working out

With Structured Outputs at `low` and `medium` it often answers without thinking, and accuracy drops. Add `Think the problem through before you answer.` at the end of the system prompt (at `high` it brings accuracy close to `xhigh`), or run `xhigh`. Treat any `stop_reason: "max_tokens"` as failed even when the text parses. Without Structured Outputs, parse the last JSON value in the text, not the span from the first `{` to the last `}`. `between_tools` in a request without tools means no thinking at all, so do not use it for these.

## Mid-turn messages and harness text

Trained against indirect injection, it sometimes reads a genuine user message as one. Never put user text inside a `tool_result`; append it as a user text block after the last `tool_result`; keep harness notices in a separate mid-conversation system message; do not add a token or budget countdown after every tool result in interactive sessions. An occasional one-turn reminder is fine; stop after the second or third if the turn stays quiet.

## Tool calls

It occasionally calls a tool by a name that differs only in case (`bash` for `Bash`) or passes a known parameter under a near name. Accept an unambiguous match, or return `is_error: true` naming the exact expected name; it usually corrects on the next turn.

## Inside Claude Code 2.1.284

Read off the 2.1.284 binary's model catalog and a live `claude -p --model sonnet` run on 2026-09-28. Capabilities can be served remotely, so re-read a session jsonl before relying on any of this.

- `model: sonnet` resolves to `claude-sonnet-5-5` on the Anthropic API from 2.1.284; every build up to 2.1.283 resolved it to `claude-sonnet-5`. Bedrock, Vertex, Foundry and Claude Platform on AWS still resolve older Sonnets. Pin `claude-sonnet-5` where a measured behaviour must not drift.
- Baked `default_effort: "medium"`. A top-level `effortLevel` in user settings, saved before per-model `/effort`, does not reach it; one in project, local or managed settings, or passed with `--settings`, applies to every model (the same rule as Opus 5.5); agent frontmatter `effort:` and `modelSettings` do.
- It gets the LEAN system prompt (capability `lean_prompt`). Every earlier Sonnet got CLASSIC, so the six classic-only rules (no speculative abstraction, no impossible fallback, no compat shim, prefer editing an existing file, never guess a URL, flag prompt injection) no longer reach a Sonnet 5.5 main thread. It carries no `opus_5_5_prompt_bundle`, so do not assume the Opus 5.5 host sections either way; read a snapshot.
- Thinking cannot be turned off: the session toggle, `alwaysThinkingEnabled` and `MAX_THINKING_TOKENS=0` have no effect.
- The silent-turn reminder is on: after five turns with nothing for the user, "The user hasn't heard from you in a while ...". Do not add your own progress scaffolding on top.
- Content fallback: a cyber-flagged request re-runs on Sonnet 5; a bio flag ends in a refusal, because Sonnet 5.5 has no bio fallback.
- Task tools stay absent, as on Sonnet 5.

## Checklist for a Sonnet 5.5 prompt

- [ ] `effort` set explicitly and chosen by a fresh sweep; no level copied from a Sonnet 5 config.
- [ ] `thinking` omitted, `adaptive`, or `between_tools` at `high` or below; never `disabled` or `budget_tokens`.
- [ ] No `tool_choice` `any` / `tool`.
- [ ] At `low` / `medium` in agentic work: the keep-working paragraph, with the expected early stops named.
- [ ] Where scope is fixed: the no-unrequested-additions paragraph.
- [ ] At `xhigh` / `max`: the no-self-review paragraph, or a reason to want the review.
- [ ] At `low` in coding work: the real-check paragraph.
- [ ] Research and support prompts: the search-over-training paragraph, and no line that discourages tool use.
- [ ] No instruction to write reasoning into the reply.
- [ ] Conversation append-only; user text never inside a `tool_result`.
