# Stage 1 Survey and Fan-out Briefs

Read at Stage 1 entry. The skill body carries the counts policy and the reuse-bias rule; this file carries the survey command block and the brief shapes, which are needed once per run.

### 1a. Directory survey (main agent, NOT delegated)

The main agent runs this step itself. Subagents launch with shallower context than the main thread; you have all base tools and full project read access, so you build the map and pass it down via subagent briefs.

Run the directory tree in one Bash call (fallback chain so the step works without `tree` installed):

```bash
( tree -L 3 -d -I 'node_modules|.git|dist|build|.next|.nuxt|__pycache__|target|vendor' 2>/dev/null \
  || find . -type d -maxdepth 3 -not -path '*/node_modules*' -not -path '*/.git*' -not -path '*/dist*' -not -path '*/build*' | sort ) \
  && echo '---' && ls -la
```

Then Glob the language and stack markers in a single parallel batch:

- Node / TS / Bun: `package.json`, `tsconfig.json`, `bun.lockb`, `pnpm-lock.yaml`, `bun.lock`.
- Python: `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`.
- Rust / Go / PHP / Ruby / Java: `Cargo.toml`, `go.mod`, `composer.json`, `Gemfile`, `pom.xml`, `build.gradle*`.
- Conventions: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md`, `README.md`, `AGENTS.md`.

For each marker found (skip lockfiles and `node_modules`), Read it. Trace path-scoped rules: a `.claude/rules/<name>.md` with a `paths:` frontmatter applies only when an in-scope file matches; surface which rules become active for the topic.

Write the survey to `RESEARCH_DIR/00-directory-survey.md` with sections:

- `## Top-level structure`: raw tree / find output.
- `## Language / stack markers`: `file_path:line_number` for each marker plus the one-line summary (framework name + major version, key dependencies, scripts).
- `## Project conventions`: extracted CLAUDE.md / `.claude/rules/*.md` headlines, with the `paths:` scope when present.
- `## Sub-projects`: directories that contain their own `package.json` + `tsconfig.json` (Layer A authority targets at execute time per the executor's sub-project boundary rule).
- `## Provisional research angles`: 5 to 10 concrete questions the survey raised, derived jointly from topic + observed structure. Feeds 1c and 1d brief construction.

The survey is working memory for the main agent AND a referenceable artifact for subagent briefs. Subagent briefs in 1c-1d MUST anchor their REQUEST to survey-identified paths, not generic guesses.

### 1b. Reuse-bias clause (concatenate to every ac:explore brief)

Every `ac:explore` invocation in this stage carries this clause in addition to its task-specific brief:

<reuse_bias_clause>
As part of your search, surface existing utilities, modules, functions, and patterns in this codebase that could solve problems similar to the user's request. For each candidate, return absolute `file_path:line_number` and one line on what it provides. Prefix any candidate that could be reused INSTEAD OF writing new code with `REUSE:`. This feeds the plan's Reuse Map.
</reuse_bias_clause>

### 1c. Dedicated reuse-focused explore (counts toward 1d's explore total)

Spawn one `ac:explore` dedicated to the reuse search. This explore is one of the explore slots counted in 1d's floor/target; it is not additional.

<reuse_explore_brief>
CONTEXT: planning <topic>. The user has not yet decided whether to reuse existing code or write new code; that decision depends on what already exists. Directory survey landed at `RESEARCH_DIR/00-directory-survey.md`; anchor your search to the directories the survey flagged as likely homes for similar utilities.
GOAL: find existing utilities, modules, functions, and patterns in the codebase that solve problems similar to <topic>.
DOWNSTREAM: this list feeds the plan's Reuse Map. The planner references these candidates when locking "reuse vs build" decisions with the user.
REQUEST: scan the codebase, return REUSE candidates with absolute file_path:line_number and one line per candidate explaining what it provides and how it relates. Precision over recall; skip anything you cannot tie to <topic>.
</reuse_explore_brief>

### 1d. Topic-driven research fan-out (single message, parallel)

In the same assistant turn that issues 1c, spawn the rest of the cohort. Use 1a's `## Provisional research angles` as the brief skeleton; each brief targets one angle and cites at least one survey-anchored path.

**Counts policy (floor + target, scope-driven within the range)**:

- `ac:explore`: **floor 4, target 7**, INCLUDING the 1c reuse-focused explore. Smaller plans (narrow refactor, single-module change) land near the floor; broader plans (cross-module, new subsystem) land near the target. Each brief targets an independent angle; do not bundle. Typical angle set:
  - Reuse candidates (the 1c slot).
  - Similar implementations of the same shape.
  - Existing patterns and conventions in the affected module.
  - Impact map (what depends on what the plan will touch).
  - Integration points (where the new code wires into existing flows).
  - Error-handling / boundary style for the relevant surfaces.
  - Test patterns covering the surface (file layout, helpers, mocking style).
- `ac:librarian`: **floor 2, target 3**. Always at least 2, even when the topic looks purely internal:
  - Brief 1 (always): idiomatic-pattern verification against vendor docs for the libraries the topic touches. Brief shape at `${CLAUDE_SKILL_DIR}/references/librarian-brief.md` under `## Brief 1`.
  - Brief 2 (always): known-bugs research dimension (incompatibilities, deprecations, breaking default values, version-combo toolchain bugs). Brief shape in the same file under `## Brief 2`.
  - Brief 3 (when target = 3): production-quality OSS reference examples for the specific shape this plan introduces, OR a second library / framework not covered by briefs 1-2. Brief shape in the same file under `## Brief 3`, framings (a) or (b).
- `ac:oracle`: **1 only when the request signals architecture intent** (system design, infrastructure, non-trivial trade-offs). Advisory; non-blocking; do not gate on its return. Unchanged from prior behavior.

Each explore brief carries the reuse-bias clause from 1b. Each librarian brief targets a NAMED angle (one brief = one angle); do not bundle three different libraries into one brief.

All agents launched with `run_in_background: true` so you can collect results as they complete. Issue all calls in ONE assistant message with multiple Agent tool-use blocks for true parallelism. Reaching the target (7 + 3) is preferable when the topic supports it; the floor exists so trivial plans do not pay maximum token cost.

<brief_shape>
CONTEXT: [why this research, in 1-2 sentences; cite the survey-anchored path]
GOAL: [specific question to answer]
DOWNSTREAM: [how the planner will use the result]
REQUEST: [what to return, format, what to skip]
</brief_shape>

## Stage 3.5 oracle brief shape

Spawn one `ac:oracle` with `run_in_background: true`. Build the brief by selecting only the GOAL bullets matching the fired triggers (skip the rest):

```
CONTEXT: planning <topic>. Codebase state: <state>. Locked stack: <stack snapshot>. Scope IN: <list>. Scope OUT: <list>.

GOAL (only include the bullets for triggers that fired in 3.5a):
- (Trigger 1) Spot risks and subtle bugs in the locked <auth | payment | crypto | input-handling | file-upload> design. Locked decisions: <list with rationale>. Patterns the plan adopts: <file:line refs to codebase + librarian citations>.
- (Trigger 2) Verify the semantics of <chain>. Quote vendor docs lines that support each method's claimed behavior. Flag any ASSIGN-vs-EXEMPT, opt-in-vs-opt-out, or default-value pitfalls.
- (Trigger 3) Tie-break: between <option A> and <option B>, which fits the codebase state <state> at <file:line> patterns. Reason about trade-offs.
- (Trigger 4) Spot risks in this migration plan for production safety, rollback path, downtime.

DOWNSTREAM: findings inline into the plan's Stage 4 Synthesis Preview under `### Oracle Sanity-Check Findings`. CRITICAL findings flip a Stage 3.5 BLOCKER for user judgment; IMPORTANT findings are listed and the plan proceeds.

REQUEST: return findings tagged CRITICAL or IMPORTANT. Each finding includes the trigger it speaks to, the specific concern, evidence (docs URL or file:line), and a recommended action (revise / accept-as-risk / no-action). Cap at 5 findings; rank by impact. If nothing surfaces, return "No significant findings."
```

