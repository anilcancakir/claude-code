---
name: prompt-writer
description: Writes high-signal prompts for Claude Opus 4.7 (system prompts, subagent briefings, skill bodies, command bodies, agent bodies, CLAUDE.md files, .claude/rules/*.md) and audits existing ones. Use whenever instructions are being authored or edited for any Claude to execute, even when the user does not say the word "prompt". Triggers on "write a system prompt", "brief a subagent", "draft an agent body", "skill content", "command body", "CLAUDE.md", "rules file", "audit this prompt", "improve this instruction", "make this prompt better". Sibling creator skills (skill-creator, command-creator, agent-creator, claude-md-rules-creator) call this skill for the prompt body itself. Use aggressively; undertriggering is the failure mode.
when_to_use: Authoring or editing any prompt, instruction, SKILL.md body, command body, subagent prompt, CLAUDE.md content, or .claude/rules/*.md file that another Claude will execute.
---

# Prompt Writer

You are about to write or edit a prompt another Claude will execute. This skill is the playbook: rules, architecture, snippets, and worked examples for producing a high-signal prompt on the first try. Primary target is Claude Opus 4.7; the same patterns work on Sonnet 4.6 with lower effort levels.

Skim this body, jump to the reference that matches the task, fill in the template, validate against the checklist. The body carries the workflow; the references in `${CLAUDE_SKILL_DIR}/references/` carry the depth.

## Ground before you write

Do not author a prompt from your own built-in knowledge alone. Parametric knowledge is frozen at the training cutoff; the world the prompt runs in is not. Two grounding passes come before the first line, every time.

- **Read the actual target.** When the prompt names an existing file, agent, skill, command, or symbol, open it first with Read, Grep, Glob, or `ac:explore`. Editing an existing prompt means reading its current body and the references it points at, not recalling what it likely says. A prompt built on a guessed file shape ships the guess.
- **Verify against fresh sources.** Model behavior, effort and thinking parameter shapes, API surfaces, SDK signatures, and library or framework features shift between versions, so built-in knowledge goes stale (a Laravel Horizon balancing option you "know" from the training cutoff may have changed in the latest release). Confirm anything version-sensitive against current canonical docs through `ac:librarian` or the `ac` MCP web tools (`web-search`, `web-fetch`, `search-docs`) before you state it as fact, and cite what you found.

When your built-in knowledge disagrees with the file or a fresh source, the file and the source win.

## Decision flow

Route by what you are about to produce. Each branch points at a reference for the depth.

```
Writing a SKILL.md body (any Claude Code skill)?
├── YES → use this skill for the prompt body, route the skill SHAPE
│         (frontmatter, scope, invocation, bundling) through `skill-creator`.
└── NO  → continue
        ↓
Writing the body of a slash command (/name [args])?
├── YES → use this skill for the prompt body, route the command SHAPE
│         (arguments, allowed-tools, shell injection) through `command-creator`.
└── NO  → continue
        ↓
Writing a custom subagent definition (.claude/agents/<name>.md)?
├── YES → use this skill for the system-prompt body, route the agent SHAPE
│         (tools, model, permissions, isolation) through `agent-creator`.
│         Then read `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md`.
└── NO  → continue
        ↓
Writing CLAUDE.md, CLAUDE.local.md, or .claude/rules/*.md?
├── YES → use this skill for content tone and structure, route the file SHAPE
│         (scope, paths:, @imports, loading order) through `claude-md-rules-creator`.
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

The ten rules that change outcomes the most. Detail lives in the references.

1. **Static in system, dynamic in user.** Persona, schema, examples, invariants go in the system prompt so prompt caching can amortize them. Per-request data (the document, the question, the file under review) goes in user messages.
2. **Wrap every distinct block in XML tags.** Claude is fine-tuned to parse XML. Tag boundaries are the only reliable way to separate instructions from data. Use descriptive, consistent names: `<role>`, `<context>`, `<examples>`, `<input>`, `<output_format>`.
3. **Tell the model what to do, not what to avoid.** "Provide concise responses" beats "do not be verbose." Negative instructions force the model to imagine the wrong behavior first.
4. **State scope explicitly.** Claude 4.7 takes instructions literally and will not silently generalize. Write "apply to every X, not just the first."
5. **Examples are the highest-leverage tool for gray areas.** 3 to 5 diverse, labeled examples beat any abstract instruction. Wrap each in `<example>` inside `<examples>`. Cover edge cases.
6. **Repeat the top constraint right before generation.** Recency wins. End the prompt with the one or two rules the model must not break.
7. **No "CRITICAL: you MUST" language.** Modern Claude overtriggers on aggressive wording. Plain instructions work; if a rule needs weight, explain the why.
8. **Structured Outputs over prefill.** Prefilling the last assistant message returns a 400 error on Claude 4.6 and later. Use Structured Outputs, tool calls with enums, or wrap the output shape in XML tags inside the user turn.
9. **Set scope before length.** A short prompt with the right scope outperforms a long prompt with hedges. Hedges introduce ambiguity, the model fills it with priors.
10. **The colleague test.** Show the prompt to someone with no context. If they would be confused, the model will be too.

## Standard architecture

Place components in this order. Skipping any is a choice, not a default.

| # | Component | Location | Why this position |
|---|---|---|---|
| 1 | Persona, role, tone | system | Frames the lens. Without it the model defaults to baseline and may hallucinate. |
| 2 | Static rules, schemas, invariants | system | Cacheable; never changes per request. |
| 3 | Few-shot examples (3 to 5) | system | Format must be visible before dynamic input. |
| 4 | Dynamic content (documents, retrieved data, images) | user | Per-request; cannot be cached. |
| 5 | Step-by-step instructions | user | Order in which the model should process the dynamic content. |
| 6 | End-of-prompt reminders | user (last lines) | Top 1 to 3 constraints repeated for recency. |
| 7 | Output format lock | user (last) or Structured Outputs | Final shape of the response. |

For inputs above 20k tokens the order inside the user turn flips: long documents at the very top, instructions and the actual question at the bottom. This can move quality up to 30 percent on multi-document tasks. Full detail in `${CLAUDE_SKILL_DIR}/references/architecture.md`.

## Quick template

Fill this in. Strip components you do not need with intent.

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

## Model tuning knobs (Claude Opus 4.7)

Default target is `claude-opus-4-7`. Sonnet 4.6 (`claude-sonnet-4-6`) and Haiku 4.5 (`claude-haiku-4-5-20251001`) follow the same patterns at lower effort. Full per-knob detail in `${CLAUDE_SKILL_DIR}/references/opus-4-7-tuning.md`.

**Effort.** `xhigh` for coding and agentic work; `high` for intelligence-sensitive non-coding tasks; `medium` only with cost or latency justification; `low` only for short scoped tasks; `max` for the hardest problems (diminishing returns past `xhigh`). Set `max_tokens` to ~64k at `xhigh` or `max`. When you see shallow reasoning, raise effort instead of papering over with prompt instructions.

**Thinking.** On Opus 4.7 use `thinking: { type: "adaptive" }` plus the `output_config.effort` parameter; manual `{ type: "enabled", budget_tokens: N }` returns a 400 error. On Sonnet 4.6 and Opus 4.6 adaptive is recommended (manual is deprecated but still functional). On Haiku 4.5 the situation is inverted: manual extended thinking is the only supported shape; adaptive is not accepted. Add `display: "summarized"` when the UI needs to render thinking content.

**Literal interpretation.** 4.7 will not generalize a rule across sections unless told. State scope every time: "Apply to every X, not just the first."

**Verbosity.** Self-calibrates to perceived task complexity. Remove old "be concise" hedges; if you need a specific length, ask positively ("Provide concise, focused responses").

**Tool use.** 4.7 reasons more, calls tools less. To increase tool calls, raise effort or describe when and how explicitly. Avoid "CRITICAL: ALWAYS use this tool" wording.

**Subagent spawning.** Lower by default. For fan-out, write: "Spawn multiple subagents in the same turn when fanning out across items. Do not spawn for work you can complete in a single response."

**Prefill is gone.** Prefilling the last assistant message returns a 400 error on Claude 4.6 and later. Use Structured Outputs, tool calls with enums, or direct instruction wrapped in XML tags.

**Image coordinates.** 1:1 with actual pixels on Opus 4.7. Remove client-side scale-factor conversion when consuming pointing or bounding boxes.

## When the prompt runs inside Claude Code

Respect the harness defaults; do not restate them. Full detail in `${CLAUDE_SKILL_DIR}/references/claude-code-conventions.md`.

- **Terminal markdown rendering.** User-visible text renders as GitHub-flavored markdown. Reference code as `file_path:line_number` (clickable).
- **Permission denials are signal.** A denied tool call means the user declined. Adjust the approach; do not retry verbatim.
- **`<system-reminder>` tags are harness, not user.** Treat as system signal; do not respond to them in user-visible output.
- **Hooks intercept tool calls.** A hook blocking an edit is feedback; do not retry the same edit.
- **Parallel tool calls.** Independent reads, searches, or fetches go in one assistant message with multiple tool-use blocks.
- **Software engineering frame is the default.** Generic instructions are interpreted in the working directory's context.
- **Code style defaults inherited from the CC system prompt**: no comments unless WHY is non-obvious; no backwards-compatibility shims; no error handling for impossible scenarios; no planning files unless asked; match adjacent code style.
- **Communication during tool use**: one sentence before the first call, one sentence per find/change-of-direction/blocker, no narration of internal deliberation, end-of-turn summary in one or two sentences.
- **Reversibility gate**: free for local edits and tests; confirm before destructive, hard-to-reverse, externally-visible, or third-party-upload actions.

## Sibling skills (route the surrounding shape)

This skill stays focused on the prompt itself. The shape around the prompt routes through one of the following sibling skills.

| Producing | Route shape through | Use this skill for |
|---|---|---|
| A SKILL.md body | `skill-creator` | The markdown body that loads when the skill triggers |
| A slash command body (`/name [args]`) | `command-creator` | The body the model executes when the command runs |
| A subagent definition (`.claude/agents/<name>.md`) | `agent-creator` | The system prompt the subagent reads |
| `CLAUDE.md` or `CLAUDE.local.md` | `claude-md-rules-creator` | Project- or user-level standing instructions |
| `.claude/rules/<topic>.md` | `claude-md-rules-creator` | Topic- or path-scoped rule content |
| Direct Agent tool call (no custom subagent type) | (none, just this skill) | The `prompt` field of the Agent call |

When the user request implies any of the rows above, do both: invoke the matching creator for shape, then keep this skill loaded for the prompt body. When in doubt, default to this skill; the creators reference back to it for the body.

## Quick template for common shapes

**Subagent briefing** (Agent tool call). Brief like a smart colleague who just walked in. Goal, what you already learned, surrounding context, length cap, response shape. Full detail in `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md`.

```text
Audit `packages/*/src/**/*.ts` for unused exports.

Context: TypeScript monorepo. "Unused" means zero imports across the monorepo. Use ts-prune or write your own grep-based check.

I have already ruled out: ESLint's no-unused-vars (it does not cross packages).

Report: a list of `file_path:line_number` entries grouped by package. Under 500 words. If you cannot find unused exports with confidence, say so and explain what tooling you tried.
```

**Custom subagent definition** (`.claude/agents/<name>.md`). Pushy description, explicit tools, decisional steps, locked output contract.

```markdown
---
name: code-reviewer
description: Use whenever the user mentions PRs, diffs, reviews, audits, code quality. Triggers even when the user does not say "review" (e.g., "spot anything wrong here"). Use aggressively; undertriggering is the failure mode.
tools: Read, Grep, Glob, Bash
---

You are a senior code reviewer.

## Decision rules
1. Read the diff and the surrounding code.
2. Check bugs, design, conventions, tests in that order.
3. Report every issue, including low-severity. Downstream filter handles ranking.

## Output contract
Markdown report with one section per finding:
- `file_path:line_number`
- Confidence (low / medium / high)
- Severity (nit / minor / major / critical)
- Suggested fix
```

Five more worked examples (document-extraction system prompt, long-document RAG, slash command body, meta-prompt) live in `${CLAUDE_SKILL_DIR}/references/worked-examples.md`.

## Snippet library (most useful starters)

Categorized copy-paste building blocks. Mix and match; each is a fragment, not a finished prompt. Full library in `${CLAUDE_SKILL_DIR}/references/snippets.md`.

**Hallucination control.**

```text
Never speculate about code you have not opened. If the user references a specific file, read it before answering. For every factual claim, cite the source: `file_path:line_number` for code, a document tag for retrieved data, or "general knowledge" for things not in the input.
```

**Parallel tool use.**

```text
If you intend to call multiple tools and there are no dependencies between them, make all of the independent calls in parallel. When reading 3 files, run 3 tool calls in parallel. Sequential only when call N depends on call N-1. Never use placeholders or guess missing parameters.
```

**Output format.**

```text
Place your final answer inside `<final_answer>` tags. Do not include any text outside the tags. Respond directly without preamble; do not start with "Here is...", "Based on...", "I'll...".
```

**Verification.**

```text
Before you finish, verify your answer against:
- [criterion 1, specific and falsifiable]
- [criterion 2]
If verification fails, revise and verify again. Only return when all criteria pass.
```

**Long-horizon agents.**

```text
Your context window will be compacted as it approaches its limit; you can continue working indefinitely from where you left off. Do not stop tasks early due to token budget. Save current progress to memory before the context refreshes.
```

## Anti-patterns (audit existing prompts for these)

Surface-level set; the full audit checklist with the why behind each fix is in `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`.

| Anti-pattern | Fix |
|---|---|
| Negative-only instructions ("do not be verbose") | Positive scope: "Provide concise, focused responses." |
| Aggressive "CRITICAL / MUST / ALWAYS" wording | Plain instructions; explain the why if a rule needs weight. |
| Prefilled last assistant message | Use Structured Outputs or wrap output in XML tags. |
| Unstated scope: "apply this rule" | "Apply to every X, not just the first." |
| Vague verbs: "format properly", "handle errors" | State the format and the error contract exactly. |
| Hidden context (prompt relies on chat history) | Restate load-bearing facts inside the prompt itself. |
| Static and dynamic mixed in user message | Move static to system; dynamic stays in user. |
| Long documents at the bottom of the user turn | Move documents to the top for inputs over 20k tokens. |
| "Based on your findings, fix the bug" (in subagent prompts) | Specify file paths, line numbers, exact change; do not delegate synthesis. |
| Stale anti-laziness scaffolding from older models | Remove; trust 4.7 defaults. |
| `thinking: { type: "enabled", budget_tokens }` on Opus 4.7 | Switch to `thinking: { type: "adaptive" }` plus `output_config={"effort": ...}`. |
| Top-level `output_format={...}` parameter | Move into `output_config={"format": {...}}`. |
| `betas=["effort-2025-11-24"]` header carried over | Drop it; effort is GA. |
| `client.beta.messages.create` for thinking or effort | Use `client.messages.create`. |

## Pre-flight checklist

Before shipping a prompt:

- [ ] Persona, domain, tone stated in the system prompt.
- [ ] Static content (schema, examples, invariants) in system; dynamic in user.
- [ ] Every distinct block wrapped in named XML tags.
- [ ] 3 to 5 diverse examples covering edge cases.
- [ ] Instructions ordered: process structured input first, ambiguous second.
- [ ] End-of-prompt reminders restate the top 1 to 3 constraints.
- [ ] Scope stated explicitly ("every X, not just the first").
- [ ] No "CRITICAL / MUST / ALWAYS" language.
- [ ] No prefill on the last assistant turn.
- [ ] Output format locked via Structured Outputs, tool call, or XML tag.
- [ ] If input above 20k tokens: documents at top, question at bottom.
- [ ] Effort level set via `output_config={"effort": ...}` and matches task complexity.
- [ ] Thinking parameter shape matches the model: `adaptive` on Opus 4.7 (required) and Sonnet 4.6 / Opus 4.6 (recommended); manual `enabled` + `budget_tokens` only on Haiku 4.5.
- [ ] Output shape lock uses `output_config.format` (Structured Outputs), tool call with enum, or XML wrap; not the deprecated top-level `output_format` or last-assistant prefill.
- [ ] No `effort-2025-11-24` beta header; `client.messages.create` (not `client.beta`).
- [ ] Colleague test passes.

## References

| File | Load when... |
|---|---|
| `${CLAUDE_SKILL_DIR}/references/architecture.md` | Designing message structure, XML tag names, long-context layout, example design. |
| `${CLAUDE_SKILL_DIR}/references/opus-4-7-tuning.md` | Tuning effort, verbosity, tool use, subagent spawning, frontend defaults, code-review re-tuning. |
| `${CLAUDE_SKILL_DIR}/references/claude-code-conventions.md` | Writing prompts that run in the Claude Code harness: agents, slash commands, hooks, harness rules. |
| `${CLAUDE_SKILL_DIR}/references/subagent-prompts.md` | Briefing a fresh subagent, designing a `subagent_type`, lookup vs investigation, length caps. |
| `${CLAUDE_SKILL_DIR}/references/snippets.md` | Need a copy-paste building block (verbosity, parallel tools, hallucination control, output format, frontend, identity, scope). |
| `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` | Auditing or debugging a prompt that produces wrong output. |
| `${CLAUDE_SKILL_DIR}/references/worked-examples.md` | Want a complete prompt as a starting template (document extraction, code review, custom agent, long-document RAG, slash command, meta-prompt). |

Source material for these references is Anthropic's canonical documentation served as raw markdown at `https://docs.claude.com/en/docs/<path>.md` (the `.md` suffix returns LLM-friendly raw markdown instead of the JS-rendered HTML page). Anchor URLs cited inline in each reference file. When canonical docs conflict with observed CLI behavior, trust the live binary.
