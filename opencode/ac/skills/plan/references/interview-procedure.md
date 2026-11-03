<!-- ported-from: plugins/ac/skills/plan/references/interview-procedure.md sha256:3ad9469b347fd6ffd31510bf3cf1d70b865bfa7349b4f7f1fd6449cedb093428 -->
# Stage 3 Interview Procedure

Read at Stage 3 entry. The skill body carries the bounds that must hold all run; this file carries the walk-down itself, which is needed once per run.

Every user question below is a `question` tool call: a `questions` array whose entries each carry `header`, `question`, `options` (`label` plus `description`) and, for zero-or-more picks, `multiple: true`. Free text is always available to the user, so no option stands in for "Other".

Under `LANE_MODE` no `question` call below is made. Each one becomes a `pending_decisions[]` entry returned in a `DECISIONS` block, written as `<lane_mode>` in the skill body says. Stage 3a and 3b raise an entry only for `Tests?` (no test infrastructure) or for `TDD?` when the lane brief says `tdd: ask` (the `<lane_mode>` "Test mode from the brief" bullet). `QA?` is never asked: the lane records `QA = false`, because `execute --lane` skips the QA pass and an answer would be discarded.

### 3a. Build the decision tree and surface the synthesis

From the Stage 2 synthesis, extract the open questions. Each question is a node. Edges represent dependencies (answering X opens or closes Y). Group nodes into:

- Sequential nodes: each answer materially affects the next question's framing.
- Parallel branches: independent decisions that can be batched in one `question` call (up to 4 questions) or expressed as `multiple: true`. Under `LANE_MODE` all independent nodes go in one block with no cap of 4, since the coordinator does the batching into questions.

Write the synthesis to `LOG_PATH` under `## Stage 3a Synthesis`, not to the chat, and ask no question about it. The proceed-or-correct-scope gate that used to sit here was answered "proceed" in 49 of 49 measured plans and nobody ever chose "Wrong scope" or "Investigate more", so the question only cost a turn. The owner still sees the scope and can object where it matters: the Stage 4 `Lock all?` question opens with a one-line scope summary taken from this synthesis, and its `Revise / expand scope` option loops back here.

```
You asked: <restate>
What exists today: <N similar implementations at file:line refs>
Codebase fit: <High | Medium | Low> (<reason>)
Codebase state: <classification>
Effort: <Small | Medium | Large> (<file counts>)
Reuse candidates: <count>; top 3: <file:line, what>
Prerequisites: <list or "None">
Risks: <list or "None significant">
```

Then resolve the TDD and QA settings as 3b.1 and 3b.2 describe and start the 3c walk-down in the same turn.

### 3b. The routing rule (applied before every question to the user)

Before raising any question to the user, route it through this three-way check:

<routing_rule>
1. Can this be answered by reading the code? If yes, `read` / `grep` the relevant files and resolve it yourself. Record the resolution as a canonical_ref in the checkpoint.
2. Does this require external documentation or open-source patterns you do not have? If yes, spawn `ac/librarian` with a focused brief, wait for the report, then re-evaluate.
3. Is this a user preference, business decision, or value judgment that code and docs cannot answer? Then surface it via `question`.
</routing_rule>

<routing_examples>
Example A (code-answerable), do not ask the user:
- Question: "Does this codebase use ESLint or Biome?"
- Routing: code-answerable. Read package.json and look for `.eslintrc.*` or `biome.json`. Record the result in canonical_refs.

Example B (docs-answerable), spawn `ac/librarian`:
- Question: "What's the recommended retry strategy for OpenAI's chat completions API in 2026?"
- Routing: external docs. Spawn `ac/librarian` with brief targeting "OpenAI rate-limit and retry guidance, official docs, 2026".

Example C (user-answerable), use `question`:
- Question: "Should we cache responses in Redis or in-memory?"
- Routing: user preference and operational trade-off. Research provides the option list; the user picks. `question` with recommended option backed by Stage 2 findings.
</routing_examples>

This routing rule is the difference between a useful interview and spam. Apply it to every node, not just the first.

### 3b.1. TDD node

The answer affects every step's worker briefing in the execute skill (TDD enforcement directive) and the plan's `## Codebase Conventions` section. Branch on `TEST_INFRA_PRESENT` from Stage 2c.1:

- **`TEST_INFRA_PRESENT = true`: no question.** `TDD_MODE = "tdd"`, because 37 of 40 owners asked chose it. Log it to `LOG_PATH` as `TDD: tdd (defaulted, test infrastructure present)`. Three cases take another value without a question: the request itself names a mode ("no tests", "tests after"), which wins; a coordinate lane brief carries `tdd: tdd`, `tests-after` or `none`, which the lane keeps (`<lane_mode>`); and a brief with `tdd: ask` means the owner wants this lane asked, so ask `TDD?` with the options below. The Stage 4 `Lock all?` render shows the value, so the owner can still change it there.

  `TDD?` options, used only for a lane brief with `tdd: ask`:
  - `Yes, TDD (Recommended)`: `TDD_MODE = "tdd"`. Worker briefings will require "write failing test first, then implementation".
  - `Yes, tests after implementation`: `TDD_MODE = "tests-after"`. Worker briefings require tests for behavioral changes but allow implementation-first.
  - `No tests`: `TDD_MODE = "none"`. Worker briefings include no test-writing directive.

- **`TEST_INFRA_PRESENT = false`: keep asking.** The setup choice is a real decision and the framework follow-up depends on it, so it is its own call before the 3c walk-down.
  `question` (header `Tests?`, options:
  - `Set up test infrastructure + TDD (Recommended)`: `TDD_MODE = "tdd"`. The plan includes a Wave 1 step to set up the chosen framework. The user answers a follow-up to pick the framework (Vitest / Bun test / Jest / pytest / Go test, or free text).
  - `Set up test infrastructure + tests after`: `TDD_MODE = "tests-after"`. Same as above but implementation-first per step.
  - `Proceed without tests`: `TDD_MODE = "none"`. No test setup, no tests in plan. Surface this in the plan's `## Risks Accepted` because untested code is a real risk.
  )

Record the value in the checkpoint as `tdd_mode`. The plan's `## Codebase Conventions` section gets a `TDD: <mode>` field at write time.

### 3b.2. QA default

No question: the planner's own rule predicted every answer in the measured plans, so apply it and log it. The value decides whether the execute skill runs a QA pass (Phase 3e) after the review. A plan that changes a user-facing surface (a page, an HTTP endpoint, CLI output) gets `QA = true`, because the per-step checks never exercise the finished surface the way a user does; a plan that touches none (internal refactor, docs, build tooling) gets `QA = false`. Judge it from the Stage 2 synthesis and name `E2E_FRAMEWORK` from 2c.1 in the log line (a project without one runs QA through the playwright-cli fallback). `QA = true` runs the pass even when a step walks the app live, since that step's evidence reaches the tester as existing evidence rather than replacing the pass; a plan whose own verification step should be the only live check defaults to `QA = false`.

Log `QA: <true|false> (defaulted, <the rule's reason>)` to `LOG_PATH`, record it in the checkpoint as the top-level `qa`, and carry it to Stage 5, where `plan-scaffold --qa` writes it into the plan frontmatter. The Stage 4 `Lock all?` render shows it beside the TDD value, and a change typed there is applied before the scaffold.

### 3c. Walk down with recommended answers

For each node, call `question` with:

- A clear, specific question ending in `?`.
- `header` of at most 12 characters (a short label).
- 2 to 4 concrete options. Each option is a specific interpretation, example, or trade-off. No generic categories like "UI" or "Behavior".
- The FIRST option is your recommended answer; its label ends with `(Recommended)`. Recommend based on Stage 2 research, codebase conventions, and reuse opportunities.
- For independent parallel decisions: batch up to 4 questions in one `question` call, or use `multiple: true` when the user picks zero-or-more from a set.

Universal rules applied to every turn of the interview:

- Canonical-ref accumulation: when the user references a doc, spec, ADR, or file ("read X", "check Y"), `read` it immediately and append to `canonical_refs` in the checkpoint.
- Scope-creep guard: when the user mentions something outside the locked scope, capture as a Deferred Idea and redirect: `"<X> is outside this plan's scope; noting for the backlog. Back to <current decision>."` Apply this to every off-scope mention, not just the first.
- Reuse-vs-build bias: when a decision pits an existing X (with file_path:line_number) against a new Y, make the existing X the recommended option unless research clearly contradicts. The bias is reuse.
- Per-node checkpoint write: after each resolved decision, write `CHECKPOINT_PATH` with `last_stage: "3"`. Enables resume mid-interview after a compaction.
- Interview log: append every Q&A to `LOG_PATH` (decision, options presented, user selection, freeform notes). For the layout, read `references/interview-log-layout.md`.
- Re-research after path-narrowing locks: when a locked decision narrows the option space (chosen framework version, chosen library, chosen test runner), invalidate any prior research that targeted the un-chosen options. Re-orient context to the chosen path by re-reading the relevant `research/*.md` files; the early-Stage-1 fan-out may have weighted both option arms equally and the un-chosen arm's findings no longer apply. If research depth on the chosen path is thin (single source, surface-level only), spawn ONE more targeted `ac/librarian` brief BEFORE the next decision node, using the canonical brief at `references/librarian-brief.md`. Example: user locks Vue 3 after Stage 3 surfaced both Vue 2 and Vue 3 candidates, discard the Vue 2 reasoning, deepen Vue 3 research if thin, then continue with Vue 3-specific decisions. Apply this trigger after every locked decision that narrows the option space, not just framework choices.
- **Decision-tree pruning after path-narrowing locks (F23)**: after each locked Stage 3c decision, re-evaluate the REMAINING decision tree for pruning opportunities, the decision-side parallel to the research-side re-orient rule above. If a downstream decision's options ALL became moot due to the lock, drop that decision from the tree, note the pruning in the interview-log under `## Stage 3 Decision Tree Pruning`, and do NOT ask the user the dead question. Worked example: when the user locks `D4 Input modes: file only`, the downstream decisions `D5 URL handling rigor` and `D6 Path-traversal-via-URL guard` have nothing to decide (no URL surface exists): collapse both into a single `D7 Sanitizer rigor` question covering the surface that remains, or drop entirely if no surface remains. Apply this after every locked decision, not just the first; pruning compounds across the walk-down.
- **Question batching heuristic (F25)**: standalone single-question calls for GATEWAY questions whose answer changes the flow and for conditional follow-ups that depend on a prior answer within the same stage (the framework pick after `Tests?`). Batched calls (up to 4 questions per `question` call; that is a ceiling, not a target) for INDEPENDENT decisions that share no conditional dependency. After each batched call's answers arrive, re-evaluate the remaining decision tree per the pruning rule above BEFORE issuing the next batch, answers from batch N can prune nodes that would otherwise have entered batch N+1. Smaller cohesive batches (3 location-class questions together; 2 security-rigor questions together) beat arbitrary batch-of-4 fills; cohesion matters more than fill rate.

## Stage 4 synthesis preview shape

Two surfaces, written in this order in one turn: the full form appended to `LOG_PATH`, then the short
form rendered in the chat, then the `Lock all?` question.

The split is a cost decision, not a fix for anything. The one measured failure of this stage was the
question going unasked after a 908-character render, which is shorter than the cap below and shorter
than the two Stage 3 renders that carried their questions fine in the same run. Length was not the
cause; the planner had already decided to move on. What prevents a repeat is Stage 5's
`plan-scaffold --auto-mode`, which will not run without this stage's answer.

### Chat form (cap at roughly 2 KB)

Only what the user is being asked to react to. Every section here is a thing they can still change by
answering `Revise a decision` or `Revise / expand scope`.

```
## Confirmed Understanding: <topic>

### Goal
<locked goal in one or two lines, falsifiable: current state, target state, acceptance criterion>

### Scope
- IN: <list>
- OUT: <list>

### Locked Decisions
| Decision | Choice |
|---|---|
| <decision> | <choice> |

### Hard constraints research produced
- <constraint that narrows the plan, with the `file:line` or URL that established it>

### Oracle findings (only when Stage 3.5 surfaced IMPORTANT ones)
- [IMPORTANT] <trigger>: <concern>. Recommended action: <revise | accept-as-risk | no-action>.

Defaults: TDD <tdd | tests-after | none>, QA <yes | no>; say so here to change

Full synthesis, conventions, reuse map and references: `<LOG_PATH>`.
```

The `Defaults:` line is always present. It is how one question still covers the TDD and QA values 3b.1 and 3b.2 settled without asking: a reply to `Lock all?` that names a different TDD or QA value changes it, and you re-ask `Lock all?` once with the new line. The `Lock all?` question text opens with the one-line scope summary that replaces that gate: `<You asked, restated> | fit <High|Medium|Low>, effort <Small|Medium|Large> | scope IN: <headline>`.

### Log form (appended to `LOG_PATH`, no cap)

Everything below is an input to the plan file you are about to write rather than a decision the user
is making, so it belongs in the log. Writing it to the chat costs the turn and buys nothing: the next
thing that reads it is you, at Stage 5, from the plan you are writing.

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
- Path aliases: <mapping; omit the line when none>
- TDD: <tdd | tests-after | none>
- LSP false-positive whitelist: <symbols and patterns; omit the line when none>
- Test mount discipline: <canonical pattern and banned APIs; omit the line when none>
- QA learnings: <topic-relevant lines from `.ac/qa/learnings.md`; omit the line when none>

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
