# Claude Models

The shared layer for a prompt that Claude Opus 5.5, Sonnet 5.5 or Haiku 5.5 will run, on the Anthropic API or inside Claude Code. Read this file, then the card of the target model: `opus-5-5-tuning.md`, `sonnet-5-5-tuning.md` or `haiku-5-5-tuning.md`. Scope is these three models. Older Claude models (Opus 5 and earlier, Sonnet 5 and earlier, Haiku 4.5) and the Fable line are not covered. That matters outside the Anthropic API, where any of the three aliases can resolve to an older model (see the table under "Claude Code" below, for example `opus` is Opus 4.6 on Foundry): pin a full model ID there and read that model's own Anthropic page.

Each claim carries a label: **Doc** (an Anthropic page for the model), **Carried** (Anthropic's Opus 5 prompting page, which Anthropic calls a reasonable starting point for Opus 5.5, or the general best-practices page), **Host** (Claude Code docs or the 2.1.318 binary), **Measured** (this plugin's own runs, with n; one project's numbers, not Anthropic's) and **Inference** (this skill's reading).

Primary sources, fetched 2026-11-23 (raw markdown through the `.md` suffix):

- Prompting pages: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5.md , `prompting-claude-sonnet-5-5.md`, `prompting-claude-haiku-5-5.md`, and `prompting-claude-opus-5.md` (Carried)
- What's new: https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5.md , `models/sonnet-5-5/whats-new-sonnet-5-5.md`, `models/haiku-5-5/whats-new-haiku-5-5.md`
- Effort, thinking, best practices, refusals: https://platform.claude.com/docs/en/build-with-claude/effort.md , `thinking.md`, `prompt-engineering/claude-prompting-best-practices.md`, `refusals-and-fallback.md`
- Claude Code: https://code.claude.com/docs/en/model-config.md , `sub-agents.md`

## At a glance (Doc)

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| ID | `claude-opus-5-5` | `claude-sonnet-5-5` | `claude-haiku-5-5` (no date suffix) |
| Released | 2026-09-22 | 2026-09-28 | 2026-10-07 |
| Context, max output | 1M, 128K | 1M, 128K | 1M, 128K |
| Default effort | `medium` | `high` on the API, `medium` in Claude Code | `medium` |
| Thinking | adaptive, always on; `disabled`, manual `budget_tokens` and `between_tools` return 400 | adaptive; `between_tools` at `high` or below; `disabled` and manual return 400 | adaptive; `disabled` at `high` or below (400 at `xhigh` and `max`); manual and `between_tools` return 400 |
| Forced `tool_choice` | 400, only `auto` and `none` | 400, only `auto` and `none` | accepted; the reply starts with the tool call, no text before it |
| Price per 1M, in / out | $4 / $20 | $2 / $10 | $0.10 / $0.50 up to 100k-token prompts, $0.50 / $2.50 above |
| Cache read | $0.20 | $0.10 | $0.01 |
| Refusal fallback | server-side, except `reasoning_extraction` | retries `cyber` and `frontier_llm` on Sonnet 5 only | none |
| Anthropic's use | long-running agentic coding and knowledge work | speed plus intelligence; the hardest long-horizon work goes to an Opus model | high-volume, latency-sensitive work: classification, extraction, routing, subagents |

## What all three share

- **Effort is the depth lever, prose is not (Doc).** Opus: "Lowering effort reduces thinking, and with it cost and latency, more reliably than prompt instructions do." Sonnet: "Asking the model in the system prompt to think less doesn't reliably reduce its thinking." Haiku: "telling the model in the prompt to answer directly didn't stop it from thinking." Set `effort` explicitly. Labels do not port between models: Opus 5.5 at `medium` matches or beats Opus 5 at `high`, and Sonnet 5.5's levels are recalibrated.
- **Leave room in `max_tokens` (Doc).** Thinking counts toward it even when not returned; 128,000 is the maximum and "has worked well" for long agentic turns.
- **Cache and effort (Doc).** Changing the top-level `effort` between requests invalidates the cached messages. A per-message effort change (beta, header `mid-conversation-output-config-2026-07-01`) keeps the cache; it needs adaptive thinking, and its availability differs by platform (check the effort-per-message page's availability table before relying on it).
- **Task budgets (Doc).** Task budgets (beta) add a countdown that Anthropic says has not been seen to cause the mid-turn misread on Sonnet 5.5; if you see the misread while one is set, try the session without it. Haiku 5.5 does not receive context-awareness tags; its what's-new page points to task budgets for an explicit budget in an agentic loop.
- **Sampling and prefill (Doc, Carried).** Omit `temperature`, `top_p` and `top_k`; non-default values return a 400. A prefilled last assistant turn is unsupported since Claude 4.6. End `messages` with a user turn and lock the shape with `output_config.format`, a tool call or a tag.
- **No reasoning in the reply (Doc).** A prompt that asks for the model's reasoning in the response can be declined with `reasoning_extraction`, which fallback does not retry. Remove the instruction, ask for a short explanation or a summary of actions, and read `display: "summarized"` thinking blocks.
- **Progress notes come back as thinking blocks (Doc, Opus and Sonnet only).** Between tool calls Opus 5.5 and Sonnet 5.5 write progress notes as progress-update `thinking` blocks, empty at the default `display`, so a client that renders only `text` looks silent. `display: "updates"` (beta, header `thinking-display-updates-2026-08-18`) returns a summary of each. Haiku 5.5 is not on the thinking page's list of models that write them, so do not wait for notes there.
- **Keep the history append-only (Doc).** Editing earlier messages, rebuilding `system` or `tools`, or summarizing older turns in place invalidates every later thinking block. A new rule goes into a mid-conversation system message or the newest turn, not into `system`. A prompt that adds text "from the first request" (the unattended paragraph, the date line) must do so at session start.
- **Mid-turn user text (Doc for Sonnet and Haiku, Inference for Opus).** Never place user text inside a `tool_result`; append it as a text block after the last `tool_result`; keep harness notices in a separate mid-conversation system message, not in the same block as the user's words. In an interactive session do not add a token or budget countdown after every tool result.
- **Check a change before calling it done (Doc, Sonnet and Haiku pages).** At `low` effort Sonnet 5.5 and at `low` and `medium` Haiku 5.5 sometimes report a code change as done without running a check. Anthropic's paragraph, identical on both pages:

  ```text
  When you change code that can be run, built, or type-checked, run a real check that exercises the change before reporting it done: the project's tests, type-checker, or build, or the changed command itself. A syntax-only check, or a check command that failed to start, does not count; if all that is missing is the project's declared dependencies, install them with its own package manager and lockfile (for example, npm install or pip install -r requirements.txt), never through sudo or the system package manager, unless told not to. Only if no real check can run here, say which one you did not run and why instead of reporting the change as done.
  ```

- **Name the early stops (Doc for Opus, Inference for Sonnet and Haiku).** The Opus page says the model "is responsive to instructions that name the specific kinds of early stop you want it to avoid", and to name the stops you do want (nothing can move without the user, a blocker you protect). The Sonnet and Haiku pages give a paragraph without saying the same; naming the stops is this skill's extension. Each card carries its model's paragraph.
- **Plain techniques still apply.** Clear and direct wording, one tag family for data, 3 to 5 examples, scope stated in both directions, the colleague test: `SKILL.md` core principles and `architecture.md`.

## Claude Code (Host)

- **Aliases (Claude Code docs, 2.1.318 binary).** On the Anthropic API `opus`, `sonnet` and `haiku` resolve to the three 5.5 models (from Claude Code 2.1.280, 2.1.284 and 2.1.293). Elsewhere:

  | Provider | `opus` | `sonnet` | `haiku` |
  |---|---|---|---|
  | Bedrock, Vertex | Opus 5.5 | Sonnet 4.5 | Haiku 4.5 |
  | Claude Platform on AWS | Opus 5.5 | Sonnet 4.6 | Haiku 4.5 |
  | Claude Models on Google Cloud | Opus 5.5 | Sonnet 5.5 | Haiku 4.5 |
  | Microsoft Foundry | Opus 4.6 | Sonnet 4.5 | Haiku 4.5 |

  Pin a full ID (`claude-sonnet-5-5`, or `ANTHROPIC_DEFAULT_SONNET_MODEL`) when a measured behaviour must not drift.
- **Effort.** All three default to `medium` in Claude Code. Order, first hit wins: `CLAUDE_CODE_EFFORT_LEVEL`, an in-session pick (`/effort`, `/model`), `--effort`, settings, the model default. A top-level `effortLevel` in user settings does not count for any of the three 5.5 models ("Opus 5.5 and models released after it start at their own default"); one in project, local or managed settings applies to every model. `ultrathink` in a prompt raises that turn to `xhigh` (v2.1.311 or later in the terminal); "think hard" is ordinary text. A skill's `effort` lasts for the turn it runs in. A subagent's `effort` overrides the session level but not the env var; `CLAUDE_CODE_SUBAGENT_EFFORT` (2.1.316) sets the level when nothing else names one, and a subagent on another model uses that model's saved or default level (2.1.317).
- **Thinking** cannot be turned off on any of the three in Claude Code.
- **System prompt.** All three get the LEAN shape (the `lean_prompt` capability in the 2.1.318 catalog). It carries a short `# Harness` list and lacks the CLASSIC-only rules (no speculative abstraction, no impossible-case handling, no compat shims, prefer editing a file, never guess a URL, flag injection), so a body that needs one states it in one line. Verbatim host text per shape: `claude-code-builtin-prompts.md`.
- **What a prompt sees.** CLAUDE.md, output-style text, hook `additionalContext` and the skill list arrive as system reminders inside user messages, not in `system`. A subagent receives its own body, environment details and CLAUDE.md (unless `omitClaudeMd: true`), not the Claude Code system prompt, so a delegation prompt carries every rule the subagent needs.
- **Skills survive compaction in part.** The first 5,000 tokens of each invoked skill are re-attached, 25,000 shared: binding rules go at the top of a `SKILL.md`.

## Porting a prompt between the three (Inference on the facts above)

| From to | What to change |
|---|---|
| Opus 5.5 to Sonnet 5.5 | Effort default is `high` on the API (set it); `between_tools` becomes available; expect check-ins at `low` and `medium` and unrequested tests and docs; drop the Opus unattended paragraph unless measured. |
| Opus 5.5 to Haiku 5.5 | Add the keep-working and verify paragraphs for long agent prompts at `low` and `medium`; give the date with a search tool; `disabled` thinking is allowed at `high` or below; forced `tool_choice` is accepted; no server-side fallback and no progress-update blocks. |
| Sonnet 5.5 to Haiku 5.5 | Forced `tool_choice` and `disabled` thinking (at `high` or below) become valid; `between_tools` returns 400; compare any `xhigh` run against Sonnet 5.5 (Anthropic's advice). |
| Haiku 5.5 to Sonnet 5.5 or Opus 5.5 | Forced `tool_choice` returns 400 (use `auto` plus a prompt line, or Structured Outputs); `thinking: {"type": "disabled"}` returns 400 (Sonnet: `between_tools` at `high` or below; Opus: no off switch); the Haiku-specific paragraphs may be unnecessary, so remove them by measurement. |
| Any to a non-Anthropic-API alias | The alias may resolve to an older model: re-read the scope note and pin the ID. |

## Checklist for a Claude 5.5 prompt

- [ ] The target model is named, and its card read.
- [ ] `effort` set explicitly and chosen by measurement; no level copied from another model.
- [ ] `thinking` omitted or adaptive (Sonnet: `between_tools` only at `high` or below; Haiku: `disabled` only at `high` or below); no manual `budget_tokens`.
- [ ] No sampling parameters, no prefill, no forced `tool_choice` on Opus or Sonnet.
- [ ] `max_tokens` sized for thinking plus the reply.
- [ ] No instruction to write reasoning into the reply, and no "think less" line used as a depth control.
- [ ] Static prefix append-only; late rules in a mid-conversation system message.
- [ ] User text never inside a `tool_result`; no countdown after every tool result in interactive sessions.
- [ ] Early stops that matter are named, with the stops to keep.
- [ ] Code agents at the levels above carry the verify paragraph.
