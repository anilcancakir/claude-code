# Stage 3 Interview Procedure

Read at Stage 3 entry. The skill body carries the bounds that must hold all run; this file carries the walk-down itself, which is needed once per run.

### 3a. Build the decision tree and surface the synthesis

From the Stage 2 synthesis, extract the open questions. Each question is a node. Edges represent dependencies (answering X opens or closes Y). Group nodes into:

- Sequential nodes: each answer materially affects the next question's framing.
- Parallel branches: independent decisions that can be batched in one `AskUserQuestion` call (up to 4 questions) or expressed as `multiSelect: true`.

Surface the synthesis as plain text in the chat before the first question:

```
Before we start the interview, here is what I found:

You asked: <restate>
What exists today: <N similar implementations at file:line refs>
Codebase fit: <High | Medium | Low> (<reason>)
Codebase state: <classification>
Effort: <Small | Medium | Large> (<file counts>)
Reuse candidates: <count>; top 3: <file:line, what>
Prerequisites: <list or "None">
Risks: <list or "None significant">

I have <N> decisions to walk through with you. Each comes with a recommended answer.
```

Then call `AskUserQuestion` (header `Proceed?`, options `Proceed (Recommended)` / `Wrong scope, correct first` / `Investigate more first`). On Wrong scope: ask freeform follow-up, return to Stage 0f. On Investigate more first: ask which area, spawn the matching agents, return to Stage 1d.

### 3b. The routing rule (applied before every question to the user)

Before raising any question to the user, route it through this three-way check:

<routing_rule>
1. Can this be answered by reading the code? If yes, Read / Grep / LSP the relevant files and resolve it yourself. Record the resolution as a canonical_ref in the checkpoint.
2. Does this require external documentation or open-source patterns you do not have? If yes, spawn `ac:librarian` with a focused brief, wait for the report, then re-evaluate.
3. Is this a user preference, business decision, or value judgment that code and docs cannot answer? Then surface it via `AskUserQuestion`.
</routing_rule>

<routing_examples>
Example A (code-answerable), do not ask the user:
- Question: "Does this codebase use ESLint or Biome?"
- Routing: code-answerable. Read package.json and look for `.eslintrc.*` or `biome.json`. Record the result in canonical_refs.

Example B (docs-answerable), spawn `ac:librarian`:
- Question: "What's the recommended retry strategy for OpenAI's chat completions API in 2026?"
- Routing: external docs. Spawn `ac:librarian` with brief targeting "OpenAI rate-limit and retry guidance, official docs, 2026".

Example C (user-answerable), use `AskUserQuestion`:
- Question: "Should we cache responses in Redis or in-memory?"
- Routing: user preference and operational trade-off. Research provides the option list; the user picks. `AskUserQuestion` with recommended option backed by Stage 2 findings.
</routing_examples>

This routing rule is the difference between a useful interview and spam. Apply it to every node, not just the first.

### 3b.1. TDD interview node (mandatory when test infrastructure relevant)

Before the general decision tree walk-down, ask the TDD question. This is a separate node because the answer affects every step's worker briefing in `/ac:execute` (TDD enforcement directive) and the plan's `## Codebase Conventions` section.

Branch on `TEST_INFRA_PRESENT` from Stage 2c.1:

- If `TEST_INFRA_PRESENT = true`:
  `AskUserQuestion` (header `TDD?`, options:
  - `Yes, TDD (Recommended)`: `TDD_MODE = "tdd"`. Worker briefings will require "write failing test first, then implementation".
  - `Yes, tests after implementation`: `TDD_MODE = "tests-after"`. Worker briefings require tests for behavioral changes but allow implementation-first.
  - `No tests`: `TDD_MODE = "none"`. Worker briefings include no test-writing directive. Use this only when the user explicitly opts out of tests for this plan.
  )

- If `TEST_INFRA_PRESENT = false`:
  `AskUserQuestion` (header `Tests?`, options:
  - `Set up test infrastructure + TDD (Recommended)`: `TDD_MODE = "tdd"`. The plan includes a Wave 1 step to set up the chosen framework. The user answers a follow-up to pick the framework (Vitest / Bun test / Jest / pytest / Go test / Other).
  - `Set up test infrastructure + tests after`: `TDD_MODE = "tests-after"`. Same as above but implementation-first per step.
  - `Proceed without tests`: `TDD_MODE = "none"`. No test setup, no tests in plan. Surface this in the plan's `## Risks Accepted` because untested code is a real risk.
  )

Record the choice in the checkpoint as `tdd_mode` and surface it in the Stage 4 Synthesis Preview. The plan's `## Codebase Conventions` section gets a `TDD: <mode>` field at write time.

### 3c. Walk down with recommended answers

For each node, ask `AskUserQuestion` with:

- A clear, specific question ending in `?`.
- `header` of at most 12 characters (chip label).
- 2 to 4 concrete options. Each option is a specific interpretation, example, or trade-off. No generic categories like "UI" or "Behavior".
- The FIRST option is your recommended answer; its label ends with `(Recommended)`. Recommend based on Stage 2 research, codebase conventions, and reuse opportunities.
- For independent parallel decisions: batch up to 4 questions in one `AskUserQuestion` call, or use `multiSelect: true` when the user picks zero-or-more from a set.

Universal rules applied to every turn of the interview:

- Canonical-ref accumulation: when the user references a doc, spec, ADR, or file ("read X", "check Y"), Read it immediately and append to `canonical_refs` in the checkpoint.
- Scope-creep guard: when the user mentions something outside the locked scope, capture as a Deferred Idea and redirect: `"<X> is outside this plan's scope; noting for the backlog. Back to <current decision>."` Apply this to every off-scope mention, not just the first.
- Reuse-vs-build bias: when a decision pits an existing X (with file_path:line_number) against a new Y, make the existing X the recommended option unless research clearly contradicts. The bias is reuse.
- Per-node checkpoint write: after each resolved decision, write `CHECKPOINT_PATH` with `last_stage: "3"`. Enables resume mid-interview after auto-compact.
- Interview log: append every Q&A to `LOG_PATH` (decision, options presented, user selection, freeform notes). For the layout, read `${CLAUDE_SKILL_DIR}/references/interview-log-layout.md`.
- Re-research after path-narrowing locks: when a locked decision narrows the option space (chosen framework version, chosen library, chosen test runner), invalidate any prior research that targeted the un-chosen options. Re-orient context to the chosen path by re-reading the relevant `research/*.md` files; the early-Stage-1 fan-out may have weighted both option arms equally and the un-chosen arm's findings no longer apply. If research depth on the chosen path is thin (single source, surface-level only), spawn ONE more targeted `ac:librarian` brief BEFORE the next decision node, using the canonical brief at `${CLAUDE_SKILL_DIR}/references/librarian-brief.md`. Example: user locks Vue 3 after Stage 3 surfaced both Vue 2 and Vue 3 candidates, discard the Vue 2 reasoning, deepen Vue 3 research if thin, then continue with Vue 3-specific decisions. Apply this trigger after every locked decision that narrows the option space, not just framework choices.
- **Decision-tree pruning after path-narrowing locks (F23)**: after each locked Stage 3c decision, re-evaluate the REMAINING decision tree for pruning opportunities, the decision-side parallel to the research-side re-orient rule above. If a downstream decision's options ALL became moot due to the lock, drop that decision from the tree, note the pruning in the interview-log under `## Stage 3 Decision Tree Pruning`, and do NOT ask the user the dead question. Worked example: when the user locks `D4 Input modes: file only`, the downstream decisions `D5 URL handling rigor` and `D6 Path-traversal-via-URL guard` have nothing to decide (no URL surface exists): collapse both into a single `D7 Sanitizer rigor` question covering the surface that remains, or drop entirely if no surface remains. Apply this after every locked decision, not just the first; pruning compounds across the walk-down.
- **AskUserQuestion batching heuristic (F25)**: standalone single-question calls for GATEWAY questions whose answer changes the flow (3a Proceed?, 3b.1 Tests? when test-infra detection branches, conditional follow-ups that depend on a prior answer within the same stage). Batched calls (up to 4 questions per AskUserQuestion invocation; that is the spec hard cap, not a target) for INDEPENDENT decisions that share no conditional dependency. After each batched call's answers arrive, re-evaluate the remaining decision tree per the pruning rule above BEFORE issuing the next batch, answers from batch N can prune nodes that would otherwise have entered batch N+1. Smaller cohesive batches (3 location-class questions together; 2 security-rigor questions together) beat arbitrary batch-of-4 fills; cohesion matters more than fill rate.

## Stage 4 synthesis preview shape

Rendered as plain chat text at Stage 4, before the lock question. Cap it at roughly 8 KB; for longer
content summarize each section to two sentences and link the full text from `LOG_PATH`.

```
## Confirmed Understanding: <topic>

### Goal
<locked goal, falsifiable: current state, target state, acceptance criterion>

### Scope
- IN: <list>
- OUT: <list>

### Codebase Conventions (will be embedded in plan)
- Naming: <pattern>
- Error handling: <style>
- Comment density: <level>
- Type discipline: <level>
- File organization: <pattern>
- Import convention: <pattern>

### Reuse Map (existing code to leverage)
- file_path:line_number, what it provides, which decision uses it

### Locked Decisions
- <decision>: <choice> (<rationale>)

### Oracle Sanity-Check Findings (only when Stage 3.5 surfaced findings)
- [IMPORTANT] <trigger>: <concern>. Evidence: <docs URL or file:line>. Recommended action: <revise | accept-as-risk | no-action>.

(If Stage 3.5 fired zero triggers OR oracle returned no findings, omit this subsection entirely. CRITICAL findings are handled BEFORE this preview via the Stage 3.5c BLOCKER gate; the preview shows only IMPORTANT findings.)

### Deferred Ideas
- <idea>: <reason deferred>

### Risks Accepted (locked-default decisions kept in scope)
- <decision and recommended default>: <why accepted>

### Canonical References
- file_path:line_number, what it provides
```
