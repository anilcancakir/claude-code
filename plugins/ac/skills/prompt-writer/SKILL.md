---
name: prompt-writer
description: "Write or audit a prompt another Claude will run: system prompts, subagent briefs, skill, command and agent bodies, CLAUDE.md and rules."
when_to_use: "Use when authoring instruction text a model will follow, even if nobody says prompt."
disable-model-invocation: false
---

# Prompt Writer

You are about to write or edit a prompt another Claude will execute. Primary target is Claude Opus 5.5 (`model: opus` on Claude Code 2.1.280), whose documented baseline is Opus 5; the same shapes work on Sonnet 5.5 (`model: sonnet` on 2.1.284) at lower cost and on Fable above it.

Skim this body, jump to the matching reference, fill in the template, validate against the checklist. The references in `${CLAUDE_SKILL_DIR}/references/` carry the depth.

## Ground before you write

Do not author a prompt from built-in knowledge alone: it is frozen at the training cutoff and the world the prompt runs in is not. Two grounding passes come before the first line, every time.

- **Read the actual target.** When the prompt names an existing file, agent, skill, command, or symbol, open it first with Read, Grep, Glob, or `ac:explore`. Editing an existing prompt means reading its current body and the references it points at, not recalling what it likely says.
- **Verify against fresh sources.** Model behavior, effort and thinking parameter shapes, API surfaces, SDK signatures, and library or framework features shift between versions, so built-in knowledge goes stale. Confirm anything version-sensitive against current docs through `ac:librarian` or the `ac` MCP web tools (`web-search`, `web-fetch`, `search-docs`) before you state it as fact, and cite what you found.

When your built-in knowledge disagrees with the file or a fresh source, the file and the source win.

## Decision flow

Route by what you are about to produce. Each branch points at a reference for the depth.

```
Writing a SKILL.md body or a slash workflow (/name [args])?
├── YES → use this skill for the prompt body, route the skill SHAPE
│         (frontmatter, scope, invocation, bundling, and for a typed workflow
│         arguments and shell injection) through `ac:skill-creator`.
└── NO  → continue
        ↓
Writing a custom subagent definition (.claude/agents/<name>.md)?
├── YES → use this skill for the system-prompt body, route the agent SHAPE
│         (tools, model, permissions, isolation) through `ac:agent-creator`.
│         Then read `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md`.
└── NO  → continue
        ↓
Writing CLAUDE.md, CLAUDE.local.md, or .claude/rules/*.md?
├── YES → use this skill for content tone and structure, route the file SHAPE
│         (scope, paths:, @imports, loading order) through `ac:claude-md-rules-creator`.
└── NO  → continue
        ↓
Briefing a fresh Agent tool call (no custom subagent_type)?
├── YES → `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md`
└── NO  → continue
        ↓
Auditing or improving an existing prompt?
├── YES → `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` FIRST,
│         then `${CLAUDE_SKILL_DIR}/references/architecture.md`.
└── NO  → use the Quick template below; validate against the Quick checklist.
```

## Core principles

The ten rules that change outcomes the most.

1. **Static in system, dynamic in user.** Persona, schema, examples, invariants go in the system prompt so prompt caching amortizes them; per-request data (the document, the question, the file under review) goes in user messages.
2. **Wrap every distinct block in XML tags.** Tag boundaries are the reliable way to separate instructions from data. Use descriptive, consistent names: `<role>`, `<context>`, `<examples>`, `<input>`, `<output_format>`. In a Claude Code body, markdown headings may mark the instruction sections instead; data still goes in tags.
3. **Tell the model what to do; to move it off a default, name the exact behavior.** "Provide concise responses" beats "do not be verbose." When a default must go, a category swaps one default for another; a named list works (5.5 responds to instructions naming the specific early stops, such as "a summary that announces the next step instead of taking it").
4. **State scope explicitly, in both directions.** Where a rule must span, say so: "apply to every X, not just the first." Where the task must not widen, say that too: current Opus models can expand scope and over-verify on their own, so name the boundary ("change only these files; report adjacent problems instead of fixing them").
5. **Examples are the highest-leverage tool for gray areas.** 3 to 5 diverse, labeled examples beat any abstract instruction. Wrap each in `<example>` inside `<examples>`. Cover edge cases.
6. **Repeat the top constraint right before generation.** Recency wins. End the prompt with the one or two rules the model must not break.
7. **No "CRITICAL: you MUST" language.** Modern Claude overtriggers on aggressive wording. Plain instructions work; if a rule needs weight, explain the why.
8. **Structured Outputs over prefill.** Prefilling the last assistant message returns 400 on Claude 4.6 and later. Use Structured Outputs, tool calls with enums, or XML tags around the output shape in the user turn.
9. **Set scope before length.** A short prompt with the right scope outperforms a long one with hedges; the model fills hedged gaps with priors.
10. **The colleague test.** Show the prompt to someone with no context. If they would be confused, the model will be too.

## Standard architecture

Place components in this order. Skipping any is a choice, not a default.

| # | Component | Location | Why this position |
|---|---|---|---|
| 1 | Persona, role, tone | system | Frames the lens; without it the model defaults to baseline. |
| 2 | Static rules, schemas, invariants | system | Cacheable. |
| 3 | Few-shot examples (3 to 5) | system | Format visible before dynamic input. |
| 4 | Dynamic content (documents, retrieved data, images) | user | Per-request; uncacheable. |
| 5 | Step-by-step instructions | user | Order for processing the dynamic content. |
| 6 | End-of-prompt reminders | user (last lines) | Top 1 to 3 constraints, for recency. |
| 7 | Output format lock | user (last) or Structured Outputs | Final shape of the response. |

For inputs above 20k tokens the order inside the user turn flips: long documents at the very top, instructions and the actual question at the bottom. Full detail in `${CLAUDE_SKILL_DIR}/references/architecture.md`.

## Quick template

Strip components you do not need with intent.

```xml
<!-- SYSTEM PROMPT -->
<role>
You are [persona, one sentence: who, domain, tone].
</role>

<context>
[Static facts the model cannot derive: schemas, business rules, shape of the input. Cacheable.]
</context>

<examples>
  <example>
    <input>[representative input]</input>
    <expected_output>[exactly what the model should produce]</expected_output>
  </example>
  <!-- 2 to 4 more, diverse, covering edge cases -->
</examples>

<output_format>
[Shape: XML tags, JSON schema reference, plain prose, etc.]
</output_format>

<!-- USER MESSAGE -->
<input>
[The actual per-request data]
</input>

<instructions>
1. First, [process the structured part of the input].
2. Then, [interpret the ambiguous part using the structured baseline].
3. Finally, [produce the output in the shape specified above].
</instructions>

<reminders>
- [Top constraint, e.g., "cite the specific input region for every claim"]
- [Scope constraint, e.g., "apply to every section, not just the first"]
</reminders>
```

## Model tuning knobs (Opus 5.5 first)

Anthropic documents `claude-opus-5-5` as a delta over Opus 5: Opus 5 patterns hold unless noted. Per-model delta tables (max_tokens, pricing, context, safeguards) live in the `*-tuning.md` files under References: Opus 5.5, Sonnet 5.5, Haiku 5.5, and `opus-5-tuning.md` (Opus 5 baseline, Sonnet 5, Haiku 4.5, Fable).

| Knob | Opus 5.5 | Opus 5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|---|
| Default effort | `medium` | `high` | `high` on the API, `medium` in Claude Code; levels recalibrated from Sonnet 5 | low to max, default medium; first Haiku with effort |
| Thinking | always on; `disabled` and manual `budget_tokens` both 400 | on; `disabled` only at `high` or below | always on; `disabled` and manual 400; `between_tools` at `high` or below is the floor | adaptive by default; manual `budget_tokens` errors; `disabled` at `high` or below only |
| `tool_choice` `any` / `tool` | 400; use `auto` plus `strict: true`, or Structured Outputs | accepted | 400, same fix | not verified |

**Effort is the cost lever, and labels do not port.** Opus 5.5 at `medium` matches Opus 5 at `high`, and at any given label it thinks more. Start at `medium`, try `low` for scoped work, step up only on a measured gain. Lower effort before writing "think less" prose, and drop "think carefully" lines. Change effort per turn with a per-message `output_config`; changing the top-level value breaks the cache.

**Sonnet 5.5 steers by effort level.** At `low` and `medium` it checks in before agentic work is done; at every level it adds tests, docs and small files nobody asked for; at `xhigh` and `max` it starts its own review rounds. Each has a one-paragraph fix in `sonnet-5-5-tuning.md`.

**Keep the prefix append-only.** Cache reads are 0.05x input on both 5.5 models (512-token minimum), so a long static system prompt is cheap and an edited one is expensive. Editing `system` or `tools` mid-session also invalidates earlier thinking blocks on both. Late rules go in a mid-conversation system message.

**Verbosity.** Not documented for 5.5's general replies. Keep the Opus 5 practice: a positive length target, and deliverable length stated separately from chat length. Effort is not a length lever.

**Scope and delegation.** Opus 5 widens scope, re-verifies finished work, and delegates readily; 5.5 documents no reversal. Name the upper bound, and say when NOT to spawn.

**Unattended runs (5.5).** A progress report can end the turn with no tool call. For loops with no human, name the early stops you do not want (the four-stop paragraph in `opus-5-5-tuning.md`) at the end of the system prompt from turn one. An interactive setup that measured these stops may adopt it as a stated override.

**No reasoning in the reply (5.5).** "Explain your reasoning, then answer" and `<thinking>` / `<answer>` scaffolds can draw a `reasoning_extraction` refusal. Read `display: "summarized"` thinking instead.

**Assumed unchanged.** Last-turn prefill and non-default sampling parameters return 400 (assume so for 5.5). 1M context, 128k output.

## When the prompt runs inside Claude Code

What the host already says depends on the model's prompt shape; restate only what that shape lacks. Verbatim inventory in `${CLAUDE_SKILL_DIR}/references/claude-code-conventions.md`.

- **LEAN shape (Opus 5.5, Opus 5, Fable, Mythos) already carries:** markdown rendering, permission denials as signal, hook output as user feedback, mid-conversation system turns as harness, `<pasted_content>` handling, dedicated tools over shell, parallel independent calls, `file_path:line_number`, matching the surrounding code's idiom, confirming hard-to-reverse actions, faithful outcome reports, acting without re-deriving settled facts. Do not restate these.
- **LEAN does not carry** the CLASSIC-only rules: no comments unless the why is non-obvious, no speculative abstraction, no compatibility shims, no handling for impossible cases, no unasked planning files, the exploratory-question rule, UI verification, and the tool-use communication contract. A body that needs one on 5.5 states it in one line.
- **Custom subagents get neither shape.** Their system prompt is the agent body plus environment notes, so every rule the agent follows lives in the body.
- **Delegation on 5.5.** The host's 2.1.314 Agent description is cautionary ("When in doubt, don't spawn"); a prompt that holds the Agent tool still says when not to spawn.
- **Official examples: match the host's register.** `${CLAUDE_SKILL_DIR}/references/claude-code-builtin-prompts.md` holds Claude Code's own prompt text verbatim, with a Patterns section: `#` headings over short plain sentences, the reason in the same sentence as the rule, named behaviors, the wanted exception stated with the rule, no caps. Write standing instructions that way and check a body against it so it neither repeats nor contradicts the host. Section markers can be headings or XML tags (follow the target's family); data always sits inside XML tags.

## Sibling skills (route the surrounding shape)

This skill owns the prompt text; the shape around it routes through a sibling skill, and both stay loaded:

- A SKILL.md body or a slash workflow body (`/name [args]`): `ac:skill-creator`.
- A subagent definition (`.claude/agents/<name>.md`): `ac:agent-creator`.
- `CLAUDE.md`, `CLAUDE.local.md` or `.claude/rules/<topic>.md`: `ac:claude-md-rules-creator`.
- `PROJECT.md`, `ARCHITECTURE.md` or `DESIGN.md`: `ac:project-md-writer`, `ac:architecture-md-writer`, `ac:design-md-writer`.
- A direct Agent tool call (no custom subagent type): no sibling; this skill covers the `prompt` field.

When the request implies one of these, invoke the matching creator for shape and keep this skill for the prompt body.

## Quick template for common shapes

**Subagent briefing** (Agent tool call). Brief like a smart colleague who just walked in: goal, what you already learned, surrounding context, length cap, response shape. A worked briefing and the full detail: `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md`.

**Custom subagent definition** (`.claude/agents/<name>.md`): bounded description, explicit tools, decisional steps, a locked output contract, and every rule the agent needs restated in its body. For a reviewer or advisor on 5.5, ask for coverage-first findings that each carry their evidence or say "unverified" (the 5.5 system card's top epistemic issue is unverified inference asserted as fact). Full template in `${CLAUDE_SKILL_DIR}/references/worked-examples.md` Example 3, alongside document extraction, code-review briefing, long-document RAG, slash command body and meta-prompt.

## Snippet library

Copy-paste fragments (hallucination control, verification, verbosity, action defaults, output lock, subagent control, code review) live in `${CLAUDE_SKILL_DIR}/references/snippets.md`. Inside Claude Code the lean prompt already carries parallel tool use and context compaction (`# Harness`, `# Context management`), so add those only to API prompts or subagent bodies.

## Anti-patterns (audit existing prompts for these)

The full audit checklist with the why behind each fix is in `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`.

| Anti-pattern | Fix |
|---|---|
| Negative-only instructions ("do not be verbose") | Positive scope: "Provide concise, focused responses." Naming the exact default to avoid is different and works (principle 3). |
| Aggressive "CRITICAL / MUST / ALWAYS" wording | Plain instructions; explain the why if a rule needs weight. |
| Prefilled last assistant message | Use Structured Outputs or wrap output in XML tags. |
| Unstated scope: "apply this rule" | "Apply to every X, not just the first." |
| No upper bound on scope | Name the boundary; current Opus models widen scope and over-verify on their own. |
| Vague verbs: "format properly", "handle errors" | State the format and the error contract exactly. |
| Hidden context (prompt relies on chat history) | Restate load-bearing facts inside the prompt itself. |
| Static and dynamic mixed in user message | Move static to system; dynamic stays in user. |
| Long documents at the bottom of the user turn | Move documents to the top for inputs over 20k tokens. |
| "Based on your findings, fix the bug" (in subagent prompts) | Specify file paths, line numbers, exact change; do not delegate synthesis. |
| Stale anti-laziness scaffolding from older models | Remove; trust current Opus defaults. |
| 4.8-era fan-out encouragement | Invert it; Opus 5 and 5.5 already delegate readily. Say when NOT to spawn. |
| Lowering `effort` to shorten output | Effort is not a length lever. State a length target instead. |
| Effort labels copied across models; "think carefully" or reasoning-in-reply scaffolds on 5.5 | Re-sweep effort; remove the lines (the scaffold can draw a `reasoning_extraction` refusal). |
| `thinking` `enabled` + `budget_tokens`, `disabled`, or forced `tool_choice` on a model that returns 400 | Per-model shapes are in the knob table and the pre-flight checklist; omit `thinking` or send `adaptive`, and use `auto` plus `strict: true`. |
| Editing `system` or `tools` mid-session | Append a mid-conversation system message instead. |
| A body that assumes CC's classic code-style rules on 5.5 | State the rule in one line; the lean prompt does not carry it. |
| Top-level `output_format`, the `effort-2025-11-24` beta header, `client.beta.messages.create` | Use `output_config.format`; drop the header (effort is GA); use `client.messages.create`. |

## Pre-flight checklist

Before shipping a prompt:

- [ ] Persona, domain, tone stated in the system prompt.
- [ ] Static content (schema, examples, invariants) in system; dynamic in user.
- [ ] Every data block in named XML tags; instruction sections marked consistently (tags or headings).
- [ ] 3 to 5 diverse examples covering edge cases.
- [ ] Instructions ordered: process structured input first, ambiguous second.
- [ ] End-of-prompt reminders restate the top 1 to 3 constraints.
- [ ] Scope stated explicitly ("every X, not just the first").
- [ ] No "CRITICAL / MUST / ALWAYS" language.
- [ ] If input above 20k tokens: documents at top, question at bottom.
- [ ] Effort set explicitly via `output_config={"effort": ...}`, chosen by measurement (from `medium` on Opus 5.5, by a fresh sweep on Sonnet 5.5), never copied across models.
- [ ] Thinking shape matches the model: omitted or `adaptive` on Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5 and Fable; `disabled` and `between_tools` only where the knob table allows them; manual `budget_tokens` only on Haiku 4.5.
- [ ] On 5.5: no forced `tool_choice`, no reasoning-in-reply scaffold, `max_tokens` sized for thinking.
- [ ] Main-thread text (skill, command, CLAUDE.md) restates what the reader's shape lacks and nothing it carries. An agent body restates every rule it needs, except what the subagent Notes already give it (`claude-code-builtin-prompts.md`, section 5).
- [ ] No `effort` set for Haiku 4.5 (unsupported there, and on every provider where `haiku` still resolves to it); Haiku 5.5 gets one, starting at `medium`.
- [ ] Every fenced command in the body has been run, in the shell it will actually run in, and its output matches what the surrounding prose claims (see `${CLAUDE_SKILL_DIR}/references/claude-code-conventions.md`).
- [ ] Length controlled by an explicit target, not by lowering effort.
- [ ] Scope boundary named, not just scope span.
- [ ] Output shape lock uses `output_config.format` (Structured Outputs), tool call with enum, or XML wrap; not top-level `output_format` or last-assistant prefill. No `effort-2025-11-24` beta header; `client.messages.create` (not `client.beta`).
- [ ] Colleague test passes.

## References

| File | Load when... |
|---|---|
| `${CLAUDE_SKILL_DIR}/references/architecture.md` | Designing message structure, XML tag names, long-context layout, example design. |
| `${CLAUDE_SKILL_DIR}/references/claude-code-builtin-prompts.md` | Official examples and the duplicate check for anything that runs inside Claude Code: verbatim 2.1.314 prompt text per shape and model, CLAUDE.md wrapper, subagent defaults, Agent tool text, patterns worth copying. |
| `${CLAUDE_SKILL_DIR}/references/opus-5-5-tuning.md` | Targeting `claude-opus-5-5`: effort, always-on thinking, forced tool use, thinking-block binding, unattended early stops, time signals, what Claude Code 2.1.280 gives it. |
| `${CLAUDE_SKILL_DIR}/references/sonnet-5-5-tuning.md` | Targeting `claude-sonnet-5-5`: recalibrated effort, `between_tools`, check-ins, unrequested additions and self-started review by effort level, JSON answers, what Claude Code 2.1.284 gives it. |
| `${CLAUDE_SKILL_DIR}/references/haiku-5-5-tuning.md` | Targeting `claude-haiku-5-5`: first Haiku with effort, adaptive-only thinking, early stopping in long agent prompts, the 30% tokenizer change, what Claude Code 2.1.296 gives it. |
| `${CLAUDE_SKILL_DIR}/references/opus-5-tuning.md` | Tuning effort, thinking, verbosity, scope, subagent spawning, code-review re-tuning; the 4.8-to-5 inversions; per-model deltas for Sonnet 5, Haiku 4.5, Fable 5. |
| `${CLAUDE_SKILL_DIR}/references/claude-code-conventions.md` | Writing prompts that run in the Claude Code harness: agents, slash commands, hooks, harness rules. |
| `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md` | Briefing a fresh subagent, designing a `subagent_type`, lookup vs investigation, length caps. |
| `${CLAUDE_SKILL_DIR}/references/snippets.md` | Need a copy-paste building block (verbosity, parallel tools, hallucination control, output format, frontend, identity, scope). |
| `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` | Auditing or debugging a prompt that produces wrong output. |
| `${CLAUDE_SKILL_DIR}/references/worked-examples.md` | Want a complete prompt as a starting template (document extraction, code review, custom agent, long-document RAG, slash command, meta-prompt). |

Source material is Anthropic's canonical documentation; append `.md` to a URL for raw markdown. API and model docs: `https://platform.claude.com/docs/en/<path>.md`; Claude Code docs: `https://code.claude.com/docs/en/<path>.md` (the former `docs.claude.com` host redirects to the first and does not serve the Claude Code pages). When canonical docs conflict with observed CLI behavior, trust the live binary.
