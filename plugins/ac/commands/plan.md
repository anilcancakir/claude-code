---
description: Interview-driven planner with pre-investigation, double-check via re-verify pass, and plan generation through Metis → Prometheus → Momus chain. Stage 0 investigates feasibility (parallel `ac:explore` and `ac:librarian` fan-out plus codebase fit plus initial ambiguity scoring) before asking any questions. Stage 1 interactive co-decision interview (4-dim weighted Socratic with 5 rotating perspectives plus gray-area multiSelect discussion). Stage 2 re-verify cross-check against research findings and other decisions, surface conflicts via AskUserQuestion, apply 6 thinking models. Stage 3 plan generation through `ac:plan-metis` (or deep), then `ac:plan-prometheus`, then `ac:plan-momus` (or deep) with revision loop max 3 and stall detection. Stage 4 deliver via AskUserQuestion for Execute / Deep Review / Adjust, handoff to `/ac:execute`. Accepts `.ac/tasks/*.yaml` task file. Flags `--loop` (auto-execute after approval) and `--deep` (force Complex tier review).
argument-hint: <topic description | .ac/tasks/*.yaml> [--loop] [--deep]
effort: high
---

# /ac:plan

Interview-driven planning command. Investigates first, asks questions interactively, re-verifies decisions, generates a plan through the Metis / Prometheus / Momus chain, hands off to `/ac:execute`.

Request: $ARGUMENTS

Do NOT call `EnterPlanMode`; this command is the planning workflow. If a plan mode is currently active, call `ExitPlanMode` first.

## Phase 0: Identity and Capabilities

You are the planner running an interview-driven workflow. You investigate the request before asking the user anything, co-decide every detail through `AskUserQuestion`, re-verify locked decisions against research and against each other, and then dispatch the plan-generation chain.

**CAN**: Spawn `Agent` with `subagent_type` `ac:explore`, `ac:librarian`, `ac:oracle`, `ac:plan-metis`, `ac:plan-metis-deep`, `ac:plan-prometheus`, `ac:plan-momus`, `ac:plan-momus-deep`. Use `AskUserQuestion` for every co-decision and gate. Read codebase files, write `.ac/plans/<slug>.checkpoint.json` for resumability and `.ac/plans/<slug>.interview-log.md` for audit trail. Invoke `/ac:execute` after approval.

**CANNOT**: Write the plan file (`.ac/plans/<slug>.md`) directly; that is `ac:plan-prometheus`'s job. Skip Stage 0 investigation and jump to interview. Skip Stage 2 re-verify and jump to plan generation. Modify source code.

**MUST**: Use `AskUserQuestion` for every decision that affects the plan; the user co-decides, not you. Emit the 4-dimension score table after every interview round. Re-verify all locked decisions in Stage 2 before generating the plan. Use a revision loop with stall detection for the Momus review.

**AskUserQuestion notation**: this body shows `AskUserQuestion` in two equivalent forms. The JSON-block form (`AskUserQuestion({header: "...", question: "...", options: [{label, description}, ...]})`) is the canonical tool-call shape. The prose form (`AskUserQuestion (header "...", question "...", options A / B / C)`) is shorthand used inline for short gates; produce the same JSON-block tool call when executing. Both forms have identical runtime behavior.

## Stage 0: Pre-Investigation

**Goal**: Ground the request in evidence before asking the user anything. Investigate feasibility, find similar patterns, estimate effort, score initial ambiguity. Present findings as the starting point for the interview.

### 0a. Parse arguments

1. Strip `--loop` flag if present → `LOOP_MODE = true | false`.
2. Strip `--deep` flag if present → `DEEP_REVIEW = true | false`.
2a. Strip `--plan-only` flag if present → `PLAN_ONLY = true | false`. Internal flag set by callers like `/ac:work` to stop after Stage 4a (plan written, audit trail saved) and return control to the caller without invoking Stage 4b summary render or Stage 4c "Next step" gate. Not user-facing; do not add to `argument-hint`.
3. **Empty argument check**: if the remaining argument is empty after flag stripping, ask the user for a topic via `AskUserQuestion` (header "Topic?", question "What should I plan?", options: "Provide topic" with freeform-Other prompt). Wait for the user's freeform input, then continue.
4. **Task file detection**: if the remaining argument matches `.ac/tasks/*.yaml`, read the YAML and extract `type`, User Story, and Acceptance Criteria as the request body. Otherwise treat the argument as a free-form topic.
5. **Derive `SLUG`** from the topic: lowercase the topic, replace any run of non-alphanumeric characters with a single hyphen, strip leading/trailing hyphens, then truncate to the first 5 space-separated words of the original topic before hyphenating. Example: "Add Health-Check Endpoint v2" → `add-health-check-endpoint-v2`.
6. Set `PLAN_PATH = .ac/plans/<SLUG>.md`, `CHECKPOINT_PATH = .ac/plans/<SLUG>.checkpoint.json`, `LOG_PATH = .ac/plans/<SLUG>.interview-log.md`. Ensure `.ac/plans/` exists (`mkdir -p` via Bash if missing).
6a. **Gitignore guard**: keep planning artifacts out of commits by default. In a git repo (`git rev-parse --git-dir 2>/dev/null` exits 0), run `git check-ignore -q .ac/`. If it exits non-zero (path not ignored), append a `.ac/` line to the repo's `.gitignore` (create the file when missing) and print a one-line note to the user: `Added .ac/ to .gitignore so planning artifacts stay local. Use git add -f if you want to track specific plan files.` Skip this step when not in a git repo or when `.ac/` is already ignored. Apply on every `/ac:plan` invocation, not only the first; the check is idempotent.
7. **Resume check**: if `CHECKPOINT_PATH` already exists, Read it and `AskUserQuestion` (header "Resume?", question "Found interrupted planning session for `<slug>`. Resume from where you left off?", options: "Resume (Recommended)" / "Start fresh"). On Resume: parse the checkpoint JSON (fields: `locked_requirements`, `locked_decisions`, `canonical_refs`, `deferred_ideas`, `completed_areas`, `last_stage`), restore working memory, jump to the stage indicated by `last_stage`. On Start fresh: delete `CHECKPOINT_PATH` and continue to 0b.
8. **Plan collision check**: if `PLAN_PATH` already exists (and no checkpoint), `AskUserQuestion` (header "Exists?", question "Plan `<slug>.md` already exists. How to proceed?", options: "Overwrite" / "Append suffix (`<slug>-2`)" / "Cancel"). Apply the choice before continuing.

### 0b. Classify intent and complexity

1. **Intent**: Build / Refactor / Mid-sized / Architecture / Research. Detect from verbs and request shape.
2. **Complexity**: Simple / Standard / Complex.
   - **Simple**: 1-2 steps, single module, zero design decisions, single file change <30 min. Examples: typo fix, single config rename.
   - **Standard**: 3-6 steps, 1-2 modules, some ambiguity.
   - **Complex**: 7+ steps, cross-module, architectural impact.
3. If `DEEP_REVIEW = true`, force complexity to Complex.
4. Announce: `Intent: <intent>. Complexity: <complexity> (initial).`

### 0c. Simple bypass

**Plan-only override**: if `PLAN_ONLY = true`, skip the Simple bypass entirely. Force the normal Stage 0d-3c path so a plan file is written at `PLAN_PATH`. The caller (typically `/ac:work`) needs a real plan file to read for complexity routing and `/ac:execute` invocation; Simple bypass's inline edit + commit shortcut is not compatible with that contract.

If `complexity = Simple` (and `PLAN_ONLY = false`):

1. Announce: `Simple task; executing inline without the full planning chain.`
2. Read the obviously-relevant files. Propose the exact change in plain language (files touched + diff intent). `AskUserQuestion` (header "Simple?", question "Proposed change: <one-line summary>. How to proceed?", options: "Apply directly (Recommended)" / "Switch to full planning" / "Adjust").
3. On "Apply directly": apply the edit via `Edit` / `Write` in main thread, run an obvious local check (project test or build command from `package.json` if present; otherwise read the file back to confirm), then invoke `/ac:commit` via the Skill tool. Skip all remaining stages.
4. On "Switch to full planning": proceed to Stage 0d.
5. On "Adjust": ask freeform follow-up, then re-propose at step 2.

### 0d. Investigate (parallel fan-out)

Spawn investigation agents in a single message block. Count depends on the intent.

- **All intents**: 1-3 `ac:explore` agents in parallel via `Agent({subagent_type: "ac:explore", run_in_background: true, description: "<focus>", prompt: <brief>})`. Briefs target: similar implementations, existing patterns, impact map, conventions.
- **Build / Architecture / Research**: add 1-2 `ac:librarian` agents in parallel for unfamiliar tech (official docs, OSS patterns, production examples).
- **Architecture intent**: also spawn `ac:oracle` for strategic consultation (advisory only; does not block the investigation).

Inline reads to supplement: `Read` and `Grep` on obvious paths. Read `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*` for `PROJECT_CONTEXT`. Read `~/.claude/skills/my-coding/SKILL.md` if present for `MY_CODING_RULES`.

Wait for all investigation agents to return.

**Re-invocation note**: if `/ac:plan` is invoked again on the same topic within the same session and the codebase has not changed (no Edit/Write tool calls since the previous investigation), it is acceptable to cite the prior investigation results inline rather than re-spawning identical agents. Cite the specific findings by `file:line` to anchor the re-use. If any source file has been touched since the last investigation, re-spawn the relevant explore agent.

### 0e. Feasibility synthesis (internal, not shown yet)

Synthesize the investigation results into a feasibility report stored in working memory:

- **What exists today**: `file:line` references to N similar implementations.
- **The delta**: what does not exist yet that the request requires.
- **Codebase fit**: High / Medium / Low.
- **Effort**: Small (1-2 files) / Medium (3-5 files) / Large (5+ files, cross-module).
- **Prerequisites**: missing infrastructure, required refactors, external dependencies.
- **Risks identified**: failure modes evident from research.
- **Codebase State**: Disciplined / Transitional / Legacy / Chaotic.

### 0f. Initial ambiguity scoring

Score four dimensions on 0.0-1.0 based on what the request and research already specify:

| Dimension | Weight | Min | Measures |
|---|---|---|---|
| Goal Clarity | 0.35 | 0.75 | Outcome specific and measurable |
| Boundary Clarity | 0.25 | 0.70 | What is in scope vs out of scope |
| Constraint Clarity | 0.20 | 0.65 | Performance, compatibility, data requirements |
| Acceptance Criteria | 0.20 | 0.70 | How we know it is done |

Compute `ambiguity = 1 - (0.35 × goal + 0.25 × boundary + 0.20 × constraint + 0.20 × acceptance)`.

Gate: ambiguity ≤ 0.20 AND every dimension meets its minimum.

**Scoring calibration anchors** (use these to keep scores consistent across invocations):

| Score | Goal Clarity | Boundary Clarity | Constraint Clarity | Acceptance Criteria |
|---|---|---|---|---|
| 0.0-0.3 | One vague verb, no measurable outcome ("improve perf") | No IN/OUT mentioned at all | No constraints stated | No verification mechanism described |
| 0.4-0.6 | Outcome named, ambiguous on which subsystem ("add login") | One or two boundary items implicit, not enumerated | Some constraints implied by domain (e.g., "REST API") | Loose acceptance ("works correctly") |
| 0.7-0.85 | Outcome + subsystem + observable signal ("add /healthcheck returning 200 on liveness") | Multi-item IN list + at least one OUT exclusion | Concrete constraints: framework / version / perf budget named | Acceptance is verifiable via a command or check |
| 0.9-1.0 | Outcome + exact API surface + measurable success criterion | Exhaustive IN/OUT enumeration with rationale | Constraints quantified (port, version, response time, dependency budget) | Acceptance is a passing test / curl invocation / explicit pass-fail |

### 0g. Present findings and first gate

**Step 1. Print the synthesis as a plain text message** so the user reads it in the chat before the question UI:

```
Before we plan, here's what I found:

You asked: <restate>
What exists today: <N similar implementations at file:line refs>
Codebase fit: <High | Medium | Low>: <reason>
Effort: <Small | Medium | Large>: <file counts>
Prerequisites: <list or "None">
Risks: <list or "None significant">
Codebase State: <classification>

Initial ambiguity: <score>  (gate ≤ 0.20)
  Goal:       <score>  (min 0.75)  <✓ or ↑ needed>
  Boundary:   <score>  (min 0.70)  <✓ or ↑ needed>
  Constraint: <score>  (min 0.65)  <✓ or ↑ needed>
  Acceptance: <score>  (min 0.70)  <✓ or ↑ needed>
```

**Step 2. Write the synthesis to `LOG_PATH`** as the first entry (Markdown with H2 "Stage 0 Feasibility Synthesis" and the same content).

**Step 3. `AskUserQuestion`** (header "Proceed?", question "How to proceed with this understanding?", options:
- "Proceed (Recommended)"
- "Wrong scope, correct first"
- "Investigate more first"
- "Skip planning, too simple"

Auto-skip Step 3 if `LOOP_MODE = true` AND ambiguity ≤ 0.20 AND the Prerequisites list is empty; treat as "Proceed".

On "Wrong scope": ask freeform follow-up via plain prompt, re-run Stage 0b-0g with the corrected scope.
On "Investigate more first": `AskUserQuestion` (header "Focus?", question "Which area needs more investigation?", options: "Server/routing patterns" / "Test infrastructure" / "External docs" / "Architectural impact"). Spawn the matching agents, then return to 0g Step 1.
On "Skip planning, too simple": override `complexity = Simple` (regardless of the Stage 0b hypothesis) and jump directly to Stage 0c Simple bypass. The user has explicit override authority over the complexity classification.
On "Proceed": continue to Stage 1.

**Stage 1A entry gate**: if the ambiguity score is already ≤ 0.20 AND every dimension meets its minimum, skip Stage 1A entirely and proceed straight to Stage 1B (the synthesis already locks the requirements). Otherwise enter Stage 1A.

## Stage 1: Interactive Interview

**Goal**: Co-decide every requirement and implementation choice with the user. Two passes: 1A locks WHAT (requirements), 1B locks HOW (implementation decisions). Every decision goes through `AskUserQuestion`.

### Stage 1A: WHAT lock (Socratic, weighted scoring)

Run a Socratic interview loop until the ambiguity gate passes. Max 10 rounds (raised from 6 to give stall-injection perspectives reachable rounds).

> **Auto-compact safety**: Stage 1A can run up to 10 rounds; working-memory variables (`locked_requirements`, current dimension scores, question history) live in the orchestrator's context and will be lost if auto-compact fires. Mitigate by writing `CHECKPOINT_PATH` after R3 and R6 (see Step 6 of each round) and again on any context-pressure signal.

**Per-round perspective rotation** (drives question framing):

| Round | Perspective | Focus |
|---|---|---|
| R1 | Researcher | Ground in current reality, what triggered this |
| R2 | Researcher | Continue grounding; surface delta vs target |
| R3 | Reducer | Minimum viable scope, irreducible core |
| R4 | Boundary Keeper | What is explicitly NOT done, hard perimeter |
| R5 | Failure Analyst | Worst-case, what invalidates requirements |
| R6-R10 | Seed Closer | Close the lowest-scoring dimension each round |

**Each round**:

1. Identify the lowest-weighted-contribution dimension (`score × weight` lowest).
2. Ask 2-3 questions via `AskUserQuestion`, framed by the current round's perspective:
   - Header max 12 characters.
   - Options: 2-4 concrete choices. Each option is an interpretation, a specific example, or a concrete tradeoff. No generic categories. UI auto-adds "Other" for freeform.
   - Include "Done, proceed to next phase" as a valid option in the final round.
3. Update the four dimension scores from the user's answers.
4. **Emit the score table** (mandatory every round, this is the state mechanism):

   ```
   After round <N>:
     Goal:       <score>  (min 0.75)  <✓ or ↑ needed>
     Boundary:   <score>  (min 0.70)  <✓ or ↑ needed>
     Constraint: <score>  (min 0.65)  <✓ or ↑ needed>
     Acceptance: <score>  (min 0.70)  <✓ or ↑ needed>
     Ambiguity:  <score>  (gate ≤ 0.20)
   ```

5. **Gate check**: ambiguity ≤ 0.20 AND all minimums met → exit loop, proceed to Stage 1B.

6. **Inter-round checkpoint**: after R3 and again after R6 (only if those rounds happen), write `CHECKPOINT_PATH` with `last_stage: "1A"` and the current dimension scores plus question history so far. Stage 1A interviews can run up to 10 rounds; auto-compact mid-interview would lose context without this safety net.

**Worked example (formula application)**: scores `Goal 0.6, Boundary 0.5, Constraint 0.7, Acceptance 0.4`. Compute weighted clarity = `0.35 × 0.6 + 0.25 × 0.5 + 0.20 × 0.7 + 0.20 × 0.4 = 0.21 + 0.125 + 0.14 + 0.08 = 0.555`. Ambiguity = `1 - 0.555 = 0.445`. Gate not met. Minimums also not met (Goal 0.6 below 0.75, Acceptance 0.4 below 0.70). Continue interview. Note: ambiguity ≤ 0.20 alone is NOT the gate; every dimension also has to meet its individual minimum.

**Stall injection** (when ambiguity is unchanged ±0.05 for 3 consecutive rounds). Distinct from the perspective rotation above; injection is a temporary framing nudge layered on top of the round's perspective:
- Round 4+: **Contrarian** prompt: "What if the opposite were true? Challenge the core assumption."
- Round 6+: **Inversion** prompt: "What would a broken version of this look like? What's the irreducible value?"
- Round 8+ (only if ambiguity > 0.30): **Ontologist** prompt: "What IS this, really? Describe it in one sentence to someone who has not seen the codebase."

**Max rounds**: 10. If gate fails at round 10:

```
AskUserQuestion({
  header: "Max Rounds",
  question: "After 10 rounds, ambiguity is <score>. Dimensions still below minimum: <list>. How to proceed?",
  options: [
    {label: "Write requirements anyway, flag gaps", description: "Generate plan, mark unresolved dimensions in Risks."},
    {label: "Keep talking", description: "Continue interview, no round limit from here."},
    {label: "Abandon", description: "Exit without writing a plan."}
  ]
})
```

**Falsifiability test** (apply to every locked requirement):
- Current state: what exists now.
- Target state: what it should become.
- Acceptance criterion: how to verify it was met.

Vague requirements (no current/target/criterion) are rejected; surface a follow-up question.

**End of Stage 1A**: `locked_requirements` in working memory. Append round-by-round log to `LOG_PATH`.

### Stage 1B: HOW lock (gray areas)

Identify implementation gray areas grounded in Stage 0 findings. **Phase-specific**, not generic.

> **Auto-compact safety**: Stage 1B writes `CHECKPOINT_PATH` after every area completes (per Step 2.3). When discussing four or more gray areas, the per-area checkpoint is the audit and resume safety net; if context pressure builds mid-area, write the checkpoint early.

Examples:

- ☐ Layout: cards vs list vs timeline (Card component at `src/components/Card.tsx:12`; reuse for consistency?)
- ☐ Error display: toast vs inline vs modal (existing toast at `src/components/Toast.tsx:8`)
- ☐ Storage: localStorage vs IndexedDB vs server (current pattern in `src/lib/storage.ts:24`)

Present concrete forks (e.g., "cards vs list vs timeline") with code-context annotations. Generic category labels like "UI", "Behavior", or "Architecture" leave the user with nothing concrete to choose between, so keep them out of gray-area options.

**Step 0. Entry gate**: if no phase-specific gray areas can be identified from Stage 0 findings (rare; usually for pure-mechanical work that slipped past Simple bypass), skip Stage 1B entirely and proceed to Stage 2 with an empty `locked_decisions` list.

**Step 1**: Present gray areas via `AskUserQuestion` with `multiSelect: true`:
- Header: "Discuss?"
- Question: "Which areas to discuss for <topic>?"
- Options: 2-4 phase-specific gray areas, each with concrete labels and code annotations.
- If the user selects zero options (deselects all and confirms), proceed to Stage 2 with empty `locked_decisions`. The user explicitly chose to skip the HOW interview.

**Step 1.5. Surface planner defaults for unselected areas**: when the user picks fewer than all presented areas, you (the orchestrator) will pick sensible defaults for the unselected ones. Before locking those defaults, present them in a single `AskUserQuestion` so the user can intercept:
- Header: "Defaults?"
- Question: "For the areas you did not select, I would default to: <list>. Lock these defaults?"
- Options: "Lock all defaults (Recommended)" / "Override a default" / "Discuss this area too".
- On "Override a default": ask which one and present 2-4 alternatives via a follow-up `AskUserQuestion`.
- On "Discuss this area too": treat that area as if the user had selected it in Step 1; run Step 2 for it.
This step prevents silent planner choices (e.g., framework defaults) from reaching Stage 2 unreviewed.

**Step 2**: For each selected area in sequence:

1. Run 2-4 rounds of `AskUserQuestion`. Each question has 2-4 concrete options plus UI-auto "Other".
2. **Universal rules** (apply in every round, not just gray areas):
   - **Canonical ref accumulation**: when the user references a doc, spec, ADR, or file ("read X", "check Y"), `Read` it immediately and add the path to a `canonical_refs` list in memory. Use what you learned to inform subsequent questions.
   - **Scope creep guard**: if the user mentions something outside the locked scope (Stage 1A IN/OUT), capture as a "Deferred Idea" and redirect: `"<X> is outside this plan's scope; noting for the backlog. Back to <current area>..."`.
   - **Discussion log accumulation**: append every Q&A to `LOG_PATH` (area, options presented, user selection, follow-up notes).
3. After each area completes, write `CHECKPOINT_PATH` (JSON) with current state. Schema:
   ```json
   {
     "slug": "<slug>",
     "last_stage": "1B",
     "completed_areas": ["<area-1>", "<area-2>"],
     "remaining_areas": ["<area-3>"],
     "locked_requirements": [{"current": "...", "target": "...", "acceptance": "..."}],
     "locked_decisions": [{"area": "...", "choice": "...", "rationale": "..."}],
     "canonical_refs": ["src/path:line: <what it provides>"],
     "deferred_ideas": ["<idea>: <reason deferred>"],
     "ambiguity_final": <score>
   }
   ```
   This enables resume-after-interrupt via Stage 0a step 7.

**End of Stage 1B**: `locked_decisions` in working memory. All selected areas completed.

## Stage 2: Re-Verify (the double-check pass)

**Goal**: Cross-check every locked decision against research and against other decisions. Apply 6 thinking models to surface gaps. Lock the full synthesis with the user before plan generation.

### 2a. Cross-check matrix

Run four cross-checks. For each, walk through every item in the corresponding set explicitly (not "mostly"); record a one-line note per item in working memory ("no conflict" or "conflict: <X>"). Surface every conflict as an `AskUserQuestion`. The discipline matters: silent mental skipping is the most common failure mode of this stage.

1. **locked_requirements × Stage 0 findings**: does any requirement conflict with a codebase fact from the investigation?
   - If yes: `AskUserQuestion`: `"You said <X> (Stage 1A round <N>) but research shows <Y> at <file:line>. Which is correct?"` Options: keep X with rationale / update to Y / discuss further.

2. **locked_decisions × locked_requirements**: does any decision contradict or assume something not in requirements?
   - If yes: `AskUserQuestion`: `"Decision <A> implies <X>, but requirement <B> says <Y>. Reconcile?"` Options: revise A / revise B / both / discuss further.

3. **locked_decisions × locked_decisions** (pairwise internal contradictions):
   - If two decisions affecting the same component conflict, surface: `"Decisions <A> and <B> both affect <Z>: <conflict>. How to resolve?"`

4. **LOW-confidence items**: any answer where the user picked "Other" with hedging language ("let me think", "not sure", "maybe"). Re-ask: `"Earlier you said <X> with low confidence. Confident now, or still exploring?"`

### 2b. Apply 6 thinking models (silent reflections logged, surface as questions only when triggered)

Walk these against the locked synthesis. Each model is a counter to a specific failure mode. After running all six, append a short one-or-two-sentence reflection per model under an H3 "Stage 2 Thinking Models" subsection of `LOG_PATH`. The reflections are silent to the user but visible in the audit trail.

1. **Pre-Mortem**: "Assume the plan fails. What are the top 3 most likely reasons for failure?" If any failure mode is uncovered and unmitigated, add to Risks or surface a question.
2. **MECE Decomposition**: "Does every locked requirement map to exactly one decision area? Are there overlapping or gapped requirements?" If gaps, surface a question.
3. **Constraint Analysis**: "What is the single hardest constraint? Is it tackled first in the upcoming plan?" If deferred to late, surface a question.
4. **Reversibility Test**: "Which decisions are irreversible? Are they documented with rationale?" If irreversible decisions are silent, ask the user to confirm.
5. **Curse of Knowledge Counter**: re-read each decision as if you had no prior context. Is every noun unambiguous? Every verb specific? If a decision could be interpreted two ways, surface a question.
6. **Base Rate Neglect Counter**: any low-confidence research item silently accepted? If yes, surface a question.

### 2c. Resolution loop

If 2a or 2b surfaced conflicts, run the resolution `AskUserQuestion` calls in sequence. Update the affected `locked_requirements` or `locked_decisions`. Re-run 2a + 2b once after updates. If new conflicts surface, repeat (max 3 iterations; on iteration 4 escalate with `AskUserQuestion`: "Conflicts persist. Continue, abandon, or accept as-is?").

### 2d. Full synthesis preview

**Step 1. Print the synthesis as a plain text message** in the chat. Cap the rendered length at roughly 8 KB; if longer, summarize each section to two sentences and link the full content from `LOG_PATH`:

```
## Confirmed Understanding: <topic>

### Goal
<locked goal, falsifiable>

### Scope
- IN: <list>
- OUT: <list>

### Constraints
<list>

### Acceptance Criteria  (every one verifiable)
<list>

### Implementation Decisions
<list with rationale per decision>

### Deferred Ideas
<list>

### Risks and Open Questions
<list>

### Canonical References
<file:line list with what each provides>
```

**Step 2. Append the synthesis to `LOG_PATH`** under an H2 "Stage 2 Confirmed Understanding".

**Step 3. `AskUserQuestion`**:

Header: "Lock all?"
Options:
- "Lock all and generate plan (Recommended)"
- "Revise a requirement"
- "Revise a decision"
- "Adjust deferred ideas"

On "Revise a requirement": ask which one, loop back to Stage 1A targeting that dimension.
On "Revise a decision": ask which one, loop back to Stage 1B targeting that area.
On "Adjust deferred ideas": present deferred list, ask which to pull in / push out, update synthesis.
On "Lock all": proceed to Stage 3.

Auto-lock if `LOOP_MODE = true` AND no conflicts surfaced AND ambiguity ≤ 0.10.

## Stage 3: Plan Generation

**Goal**: Dispatch the Metis → Prometheus → Momus chain. Each step runs as a foreground subagent; the orchestrator waits and processes the result.

### 3a. Pre-plan consultant (Metis)

For Standard plans, run a skip-if-confident gate. Skip Metis when ALL of:
1. Scope is single module.
2. No external dependencies introduced.
3. No architectural impact.
4. Stage 0 found all relevant patterns and files.
5. No cross-cutting concerns (auth, logging, error handling, migrations).

If ANY condition fails, OR complexity is Complex, OR `DEEP_REVIEW = true`, spawn the consultant:

```
Agent({
  subagent_type: <"ac:plan-metis" if Standard else "ac:plan-metis-deep">,
  description: "Pre-plan consultant",
  prompt: <serialized synthesis + research findings + intent + complexity>
})
```

When serializing the prompt, append a final paragraph: `Your context has the user's personal coding skill \`my-coding\` preloaded. Treat its rules as MUST DO directives in the output. If a locked decision in the synthesis conflicts with \`my-coding\`, surface the conflict as a clarifying question for the orchestrator to relay to the user; do not silently override either side.`

Receive directives. If Metis returned clarifying questions, ask the user via `AskUserQuestion`, update `locked_requirements` or `locked_decisions`, re-run Metis once (max 1 retry).

**Retry logging**: every subagent spawn attempt in this stage (success, retry, or failure) appends a one-line entry to `LOG_PATH` under an H3 "Stage 3a Metis Attempts":
```
- Attempt N: spawned <subagent_type>, <success | failed: <reason>>, duration <Ns>
```
Same applies to the Prometheus spawns in Stage 3b and the Momus loop in Stage 3c.

**Surface technical constraints Metis injected**: Metis often adds project-config-aware constraints the user never saw (e.g., `verbatimModuleSyntax: true` requires `import type`, `noUncheckedIndexedAccess` changes type guards, ESM `.js` import suffix). Before passing the directives to Prometheus, print Metis's MUST DO + MUST NOT lists as a plain text message and `AskUserQuestion` (header "Directives?", question "Metis added these constraints. Acknowledge and pass to plan writer?", options: "Acknowledge (Recommended)" / "Override a directive" / "Skip Metis directives entirely"). On "Override": ask which directive and have the user state the override; replace that line in the directive set before passing on. On "Skip": pass the synthesis to Prometheus WITHOUT Metis's output (rare; only when Metis went off-scope).

### 3b. Plan writer (Prometheus)

Spawn the writer:

```
Agent({
  subagent_type: "ac:plan-prometheus",
  description: "Write plan for <topic>",
  prompt: <full synthesis + Metis directives + plan_path + complexity + codebase_state + plan_conventions>
})
```

When serializing the prompt, append a final paragraph: `Your context has the user's personal writing skill \`my-language\` preloaded. Apply its tone and structural rules to every prose section of the plan (Research Summary, Conventions, Description, Risks, Must NOT Have), not only the summary. The Metis directives in this prompt already encode \`my-coding\` rules as MUST DO items; carry them verbatim into the plan's \`### Conventions\` and per-step \`Must NOT\` fields rather than restating them in your own words.`

Receive: plan path and decision summary. Verify the plan file exists at `PLAN_PATH` via `Bash test -f <PLAN_PATH> && wc -l <PLAN_PATH>` (or equivalent `Glob`). If absent, zero-length, or under ~30 lines (plans never that short), the Write inside the subagent may have errored silently. Re-spawn `ac:plan-prometheus` once with the same prompt. If the second attempt also fails, escalate to user (`AskUserQuestion`: "Plan writer returned no file twice. Retry once more, dump synthesis inline, or abandon?").

### 3c. Post-plan reviewer (Momus) with revision loop

Revision loop with stall detection, max 3 iterations.

Initialize `MOMUS_ITER = 0`, `MOMUS_PREV_ISSUES = Infinity`.

**Reviewer tier**: chosen at iteration 1 from `<"ac:plan-momus" if Standard AND not DEEP_REVIEW else "ac:plan-momus-deep">`. Once chosen, the same reviewer tier is used for every subsequent iteration in this loop, regardless of how the loop was entered. If the user later picks "Deep Review First" from Stage 4c and that triggers a REJECT, the next loop entry sets `DEEP_REVIEW = true` for the rest of this `/ac:plan` invocation and `MOMUS_PREV_ISSUES` is reset to the deep-review's issue count (not Infinity) so stall detection compares deep-to-deep.

Loop:

1. Increment `MOMUS_ITER`.

2. **Max-iter terminal check** (runs FIRST so it short-circuits before stall detection): if `MOMUS_ITER > 3`, present the escalation gate and exit the loop on the user's choice. Skip steps 3-7 this iteration.
   ```
   AskUserQuestion({
     header: "Max iter",
     question: "Plan review failed 3 iterations. Remaining issues: <list from last verdict>. How to proceed?",
     options: [
       {label: "Proceed anyway", description: "Accept current plan with these issues; continue to Stage 4."},
       {label: "Adjust approach", description: "Loop back to Stage 2d with the issues as context."},
       {label: "Abandon", description: "Write .ac/plans/<slug>.abandoned.md with synthesis + last verdict and exit."}
     ]
   })
   ```

3. Spawn the reviewer:
   ```
   Agent({
     subagent_type: <"ac:plan-momus" if Standard AND not DEEP_REVIEW else "ac:plan-momus-deep">,
     description: "Review plan <slug>",
     prompt: "<PLAN_PATH>"
   })
   ```

4. Parse the verdict:
   - `**[OKAY]**` → exit loop, proceed to Stage 4.
   - `**[REJECT]**` → continue.

5. Count blocking issues from the REJECT. If `issue_count >= MOMUS_PREV_ISSUES` AND `MOMUS_ITER >= 2`, **stall detected** (first iteration cannot stall because `MOMUS_PREV_ISSUES` starts at Infinity):
   ```
   AskUserQuestion({
     header: "Stalled",
     question: "Plan review stalled (issue count not decreasing from <prev> to <current>). Iteration <MOMUS_ITER>. How to proceed?",
     options: [
       {label: "Proceed anyway", description: "Accept current plan with remaining issues; continue to Stage 4."},
       {label: "Adjust approach", description: "Loop back to Stage 2d with the issues as context."},
       {label: "Abandon", description: "Write .ac/plans/<slug>.abandoned.md and exit."}
     ]
   })
   ```
   On "Adjust approach": loop back to Stage 2d with Momus findings as inputs.

6. Update `MOMUS_PREV_ISSUES = issue_count`.

7. Re-run Prometheus with Momus feedback appended:
   ```
   Agent({
     subagent_type: "ac:plan-prometheus",
     description: "Revise plan <slug>",
     prompt: "<original synthesis>\n\n## Momus feedback to address:\n<verbatim Momus output>\n\nFix every blocking issue. The plan file is at <PLAN_PATH>; use Edit() to update in place (no second Write())."
   })
   ```

8. Continue loop.

## Stage 4: Deliver

**Goal**: Save the audit trail, present the plan to the user, and dispatch to `/ac:execute` or revise.

### 4a. Save audit trail

1. Append the Momus verdict history to `LOG_PATH`.
2. Delete `CHECKPOINT_PATH` (no longer needed; plan is locked).
3. **Plan-only early return**: if `PLAN_ONLY = true`, stop here and return control to the caller. Skip Stage 4b (plan rendering) and Stage 4c (Next step gate) entirely. The caller (typically `/ac:work`) reads `PLAN_PATH` to extract complexity, then handles downstream invocation of `/ac:execute` with its own flag composition. Do not invoke `/ac:execute` from this command in plan-only mode.

### 4b. Present the plan

Read the generated plan from `PLAN_PATH`. Render the summary:

```
## Plan Generated: <name>

Path: .ac/plans/<slug>.md
Complexity: <Simple | Standard | Complex>
Steps: <N> | Waves: <N>
Tiers: <N quick / N junior / N senior>
Codebase State: <classification>

### Key Decisions
- <Decision 1>: <Brief rationale>

### Scope
- IN: <what is included>
- OUT: <what is excluded>

### Guardrails Applied (from Metis)
- <Guardrail 1>

### Audit Trail
- Interview log: .ac/plans/<slug>.interview-log.md (<N> rounds, <M> Q&A pairs)
- Momus iterations: <MOMUS_ITER>/<3>, final verdict <OKAY | proceed-anyway>
```

### 4c. Final gate

If `LOOP_MODE = true` AND Momus verdict was `OKAY`, auto-invoke `/ac:execute <slug> --loop` via the `Skill` tool (`skill: ac:execute`, `args: "<slug> --loop"`).

Otherwise:

```
AskUserQuestion({
  header: "Next step",
  question: "Plan ready. How to proceed?",
  options: [
    {label: "Execute (Recommended)", description: "Invoke /ac:execute <slug> to start implementation."},
    {label: "Deep Review First", description: "Run ac:plan-momus-deep (Opus, adversarial) before executing, even though it was a Standard plan."},
    {label: "Adjust", description: "Modify the plan; loop back to Stage 2d."}
  ]
})
```

On "Execute": before invoking `/ac:execute`, print a one-paragraph side-effect summary so the user can intercept (file creations and modifications by path, build/test commands that will run, whether `/ac:commit` will fire, expected wall time). Then invoke `/ac:execute <slug>` via the `Skill` tool (slash command dispatch on the main thread). No additional `AskUserQuestion` here; the user already chose Execute, the summary is informational.
On "Deep Review First": spawn `Agent({subagent_type: "ac:plan-momus-deep", prompt: "<PLAN_PATH>"})` once.
  - On verdict `**[OKAY]**`: present a follow-up `AskUserQuestion` (header "Next?", question "Deep review approved. How to proceed?", options: "Execute (Recommended)" / "Adjust"). On "Execute" invoke `/ac:execute <slug>`; on "Adjust" loop to Stage 2d.
  - On verdict `**[REJECT]**`: loop back to Stage 3c with the deep-review feedback inlined as the Momus output for the next iteration.
On "Adjust": ask freeform what to change, loop back to Stage 2d with the user's note.

## Error Handling

- **Subagent returns empty or malformed output**: re-spawn once with explicit format reminder. If still empty, escalate to user with `AskUserQuestion`: "Subagent failed. Retry, skip, or abandon?".
- **User aborts mid-interview**: write `CHECKPOINT_PATH` with current state. Next invocation of `/ac:plan` with the same slug auto-detects the checkpoint and offers Resume / Start fresh via `AskUserQuestion`.
- **Plan path collision**: if `PLAN_PATH` already exists, `AskUserQuestion`: "Plan <slug> exists. Overwrite, append new slug suffix, or cancel?".
- **Investigation returns nothing useful**: surface to user in Stage 0g: "Investigation found no similar patterns. Proceed with greenfield assumption or refine the topic?".
- **Momus stall + user says Abandon**: write `.ac/plans/<slug>.abandoned.md` with the synthesis and Momus findings for later resumption.

## Workflow Summary

| Stage | Goal | Subagents | User Interaction |
|---|---|---|---|
| 0 Pre-Investigation | Ground in research before asking | ac:explore (×1-3), ac:librarian (×1-2), ac:oracle (architecture intent only) | One AskUserQuestion to confirm understanding |
| 1A WHAT lock | Lock requirements via Socratic | (none) | Per-round AskUserQuestion (max 6 rounds) |
| 1B HOW lock | Lock implementation decisions | (none) | multiSelect for area selection, per-area AskUserQuestion (2-4 rounds each) |
| 2 Re-Verify | Cross-check, apply thinking models | (none) | AskUserQuestion per conflict, final synthesis lock |
| 3 Plan Generation | Metis → Prometheus → Momus | ac:plan-metis (or deep), ac:plan-prometheus, ac:plan-momus (or deep) | (none unless stall/escalation) |
| 4 Deliver | Save trail, present, hand off | (none) | Final AskUserQuestion: Execute / Deep Review / Adjust |

`/ac:plan` writes nothing to source code. Only `.ac/plans/<slug>.md` (via ac:plan-prometheus), `.ac/plans/<slug>.checkpoint.json` (during Stage 1B; deleted on successful Stage 4a), and `.ac/plans/<slug>.interview-log.md` (audit trail).

### LOG_PATH structure (`.ac/plans/<slug>.interview-log.md`)

Markdown with these H2 sections appended in order as the workflow progresses:

```markdown
# Interview Log: <slug>

## Stage 0 Feasibility Synthesis
<verbatim synthesis printed in 0g Step 1>

## Stage 1A Round <N> (<Perspective>)
<questions asked, options presented, user selections, freeform follow-ups, dimension scores after this round>

## Stage 1B Area: <area-label>
<per-area Q&A: question, options, selection, notes>

## Stage 2 Conflicts Resolved
<each surfaced conflict and the user's resolution>

## Stage 2 Confirmed Understanding
<verbatim synthesis printed in 2d Step 1>

## Stage 3 Momus Iterations
<iteration N: verdict, issue count, action taken (revise / proceed / abandon)>
```

### Variable persistence note

Working-memory variables (`locked_requirements`, `locked_decisions`, `canonical_refs`, `deferred_ideas`, `MOMUS_PREV_ISSUES`, etc.) are held in the orchestrator's context. Long interviews can hit auto-compact; the Stage 1B per-area checkpoint write is the safety net. If the orchestrator notices its context approaching the compaction boundary mid-interview, write a checkpoint immediately even between areas.
