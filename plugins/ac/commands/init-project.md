---
description: Deep project-initialization command. Phase 0 parses arguments, scopes the gap-fill interview, and runs the gitignore guard for `CLAUDE.local.md`. Phase 1 spawns four parallel `ac:explore` agents across manifest plus build, languages plus frameworks, conventions plus style, and existing agent infra (AGENTS.md, .cursor/rules, .github/copilot-instructions.md). Phase 2 scores subdirectory rule candidates with an 8-factor matrix (path-scoped semantics, `>15 / 8-15 / <8` thresholds) clipped to `--max-depth` and a max-5 cap. Phase 3 invokes the `ac:claude-md-rules-creator` skill once, then drafts the root `CLAUDE.md`, optional `CLAUDE.local.md`, and up to 5 `.claude/rules/*.md` files with `paths:` frontmatter, honoring the skill's pre-flight checklist and the `.proposed` sidecar plus AskUserQuestion gate on existing files. Phase 4 reads back every emitted file, runs a parent-vs-child dedupe pass, and reports a per-file summary. Flags `--max-depth=N` (default 2), `--dry-run`, `--no-local`, `--force-overwrite` (overridden by `--dry-run`).
argument-hint: [path] [--max-depth=N] [--dry-run] [--no-local] [--force-overwrite]
effort: high
---

# /ac:init-project

Deep project investigation followed by an optimized CLAUDE.md, optional CLAUDE.local.md, and up to five path-scoped `.claude/rules/*.md` files. Fuses the `init-deep` 4-phase shape with the gap-fill interview from CC native `/init`, and drives the `ac:claude-md-rules-creator` skill as the writing playbook.

Request: $ARGUMENTS

Do NOT call `EnterPlanMode` or `ExitPlanMode`; both are deny-ruled by the overlay. This command runs on the main thread and uses no plan mode.

## Phase 0: Identity, Arguments, and Gap-Fill Interview

You are the `/ac:init-project` orchestrator. You investigate a target project, decide what standing instructions belong in which file shape, and write CLAUDE.md plus optional companions for that project. You run on the main thread; the four discovery agents in Phase 1 are subagents you spawn.

**CAN**: Use `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `LSP`, `AskUserQuestion`. Spawn `Agent` with `subagent_type: "ac:explore"` for codebase fan-out. Invoke the `ac:claude-md-rules-creator` skill at Phase 3 entry (see the exact call in section 3a). Write `<target>.proposed` sidecar files when an existing target would be overwritten.

**CANNOT**: Spawn `ac:librarian` or `ac:oracle` from this command; the surface is limited to `ac:explore` for codebase discovery. Subagents cannot spawn subagents; every discovery agent returns to this orchestrator before the next step. Author CLAUDE.md prose without first invoking `ac:claude-md-rules-creator`. Edit files outside the target project directory. Interview the user about skills, hooks, MCP servers, or `settings.json`; this command's interview surface is `CLAUDE.md` only.

**MUST**: Apply argument precedence: when both `--dry-run` and `--force-overwrite` are set, `--dry-run` wins and no `Write` or `Edit` fires. Spawn the four Phase 1 discovery agents in a single parallel block. Invoke the writing skill exactly once at the very start of Phase 3. Run the pre-flight checklist at `SKILL.md:336-361` before every `Write` (new file) or `Edit` (existing file). Cap the root `CLAUDE.md` and rule files within the line budgets stated in Phase 3.

### 0a. Parse arguments

1. Default `PATH_ARG` to the current working directory when no positional path is given; otherwise treat the first non-flag token as `PATH_ARG`. Resolve to an absolute path before any tool call.
2. `--max-depth=N`: parse the integer after `=`. Default `MAX_DEPTH=2`. Reject negative values; treat `0` as "root only".
3. `--dry-run`: set `DRY_RUN=true` if present.
4. `--no-local`: set `WRITE_LOCAL=false` if present; otherwise `WRITE_LOCAL=true`.
5. `--force-overwrite`: set `FORCE_OVERWRITE=true` if present.
6. Precedence rule: if `DRY_RUN` and `FORCE_OVERWRITE` are both true, set `FORCE_OVERWRITE=false` for the rest of the run. `--dry-run` always wins; it prints intended writes and exits before any mutation.
7. Derive `PROJECT_SLUG` from the basename of `PATH_ARG`: lowercase, replace runs of non-alphanumeric characters with a single hyphen, strip leading and trailing hyphens. Used only in user-facing messages and in the optional sibling-worktree stub filename (`~/.claude/<PROJECT_SLUG>-instructions.md`).

### 0b. Gitignore guard for `CLAUDE.local.md`

Mirror `references/claude-code-cli-source-code/commands/init.ts:139`. Run only when `WRITE_LOCAL=true`, or when a `CLAUDE.local.md` already exists at the target root and `WRITE_LOCAL=false` (the file exists, so we still want it ignored).

In `PATH_ARG`:

1. If `git rev-parse --git-dir` exits non-zero, skip the guard.
2. Otherwise run `git check-ignore -q CLAUDE.local.md`. On non-zero exit, append a `CLAUDE.local.md` line to `<PATH_ARG>/.gitignore` (create the file if missing). Print a one-line note: "Added CLAUDE.local.md to .gitignore so personal instructions stay local."

The guard is idempotent. Apply on every invocation; the `git check-ignore` short-circuits when the file is already ignored.

### 0c. Gap-fill interview (CLAUDE.md only)

Modeled on `init.ts:30-43`, scoped to `CLAUDE.md` content. Ask the minimum set of questions the codebase scan cannot answer alone. Do not interview about skills, hooks, MCP servers, or `settings.json`; those surfaces are out of scope for this command.

Use `AskUserQuestion` for each gap question that the Phase 1 results cannot resolve. Hold the questions until after Phase 1 returns; Phase 1 findings often eliminate gaps. Example gap questions, asked one at a time when Phase 1 leaves the answer ambiguous:

- header "Branch?", question "What branch and PR conventions should `CLAUDE.md` document?", options "Trunk / main only", "feature/* into main", "Other (freeform)".
- header "Env?", question "Are there required environment variables Claude must set up before running things?", options "Documented in repo", "Add to CLAUDE.md", "None".
- header "Off-limits?", question "Any paths Claude must not edit (generated code, migrations, vendored)?", options "List paths (freeform)", "None".

Skip a question when the Phase 1 agents already produced a confident finding for it.

The interview runs in `--dry-run` mode the same way it runs in a live run; the answers feed the Phase 3 drafts that are printed (not written). Only Phase 3 mutations are suppressed by `--dry-run`. Skipping the interview under `--dry-run` produces a misleading preview because the drafts shown would not match what a live run would write.

## Phase 1: Codebase Discovery

### 1a. Worktree disambiguation

Run one `Bash` call: `git -C <PATH_ARG> worktree list`. When the output contains more than one worktree row, ask the user to disambiguate via `AskUserQuestion` (header "Worktrees?", question "Multiple git worktrees detected. Where do your sibling worktrees live relative to the main repo?", options "Nested inside main repo (e.g., `.claude/worktrees/<name>/`)", "Sibling or external (e.g., `../<repo>-feature/`)", "Single worktree, ignore"). The choice routes `CLAUDE.local.md` placement per `init.ts:56,150`: nested worktrees inherit the main repo's `CLAUDE.local.md` via the upward walk; sibling worktrees need a `~/.claude/<PROJECT_SLUG>-instructions.md` file with a one-line `@~/.claude/<PROJECT_SLUG>-instructions.md` stub per worktree.

Skip the question when only one worktree row is reported.

### 1b. Four parallel `ac:explore` agents

Spawn exactly four discovery agents in a single response, targeting `PATH_ARG` (not this repository). Each brief follows the "predict the standard answer first, report only the deviations" style from `init-deep.ts:38-54`. The agent returns a short report with the predicted-standard line plus any deviations cited as `file:line`.

```
Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 1 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard manifest and build setup for this kind of project, then report only deviations.\n\nCONTEXT: We are authoring CLAUDE.md for this project. Standing instructions only need to capture what Claude cannot already infer from the manifest.\n\nGOAL: Decide which build, test, lint, type-check, and run commands belong in CLAUDE.md.\n\nDOWNSTREAM: Phase 3 will feed these findings to `ac:claude-md-rules-creator`. Standard commands (`pnpm test`, `cargo test`, `pytest`) get dropped; non-standard or wrapped commands stay.\n\nREQUEST: Read every manifest, lockfile, Makefile, justfile, and CI config in the project root. Predict the conventional command set for the detected stack in one line. List the deviations as `file:line` citations: custom scripts, wrapped commands, required pre-steps, environment bootstrap. Skip standard commands the model already knows."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 2 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard language and framework set, then report only deviations.\n\nCONTEXT: We are deciding which framework facts deserve a CLAUDE.md line. Language defaults the model already knows do not.\n\nGOAL: Identify languages, framework versions, runtimes, and package managers in active use.\n\nDOWNSTREAM: Phase 3 will use the deviations to write the stack paragraph of CLAUDE.md and decide which `.claude/rules/*.md` topics are worth a path-scoped file.\n\nREQUEST: Read manifest version pins, framework config files (next.config, vite.config, tsconfig, pyproject, build.gradle, etc.), and the top of representative source files. Predict the conventional stack profile in one line. List the deviations as `file:line` citations: pinned major versions that gate features, custom resolver setups, framework-specific conventions that diverge from defaults."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 3 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard code style and report only deviations.\n\nCONTEXT: We are picking the style rules CLAUDE.md needs to encode. Defaults the linter and formatter already enforce do not belong in CLAUDE.md.\n\nGOAL: Identify formatter, linter, type-checker configuration plus any naming, layout, or testing conventions the team enforces by convention rather than by tool.\n\nDOWNSTREAM: Phase 3 will use these to populate the conventions section of CLAUDE.md, or to spin up a `.claude/rules/code-style.md` rule when the style facts are too long for the root file.\n\nREQUEST: Read `.editorconfig`, `.prettierrc`, `.eslintrc*`, `biome.json`, `ruff.toml`, `pyproject.toml` tool tables, `.golangci.yml`, `phpstan.neon`, `pint.json`, plus 2 or 3 representative source files per detected language. Predict the conventional style profile in one line. List the deviations as `file:line` citations: rules that the tooling does not catch, naming patterns, file layout conventions, test-file pairing rules."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 4 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard agent-infra footprint and report only deviations.\n\nCONTEXT: We are deciding whether the new CLAUDE.md should import existing agent-tool instructions via `@path` rather than restate them.\n\nGOAL: Inventory every pre-existing agent-tool instruction surface in the project.\n\nDOWNSTREAM: Phase 3 will either `@import` these files or migrate their content into focused `.claude/rules/*.md` topics. Either way, the root CLAUDE.md stays short.\n\nREQUEST: Check for `AGENTS.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, `.mcp.json`, existing `CLAUDE.md`, existing `.claude/rules/*.md`, existing `.claude/CLAUDE.md`. For each, report path, line count, and a one-line summary of the content. Predict the empty-set as the standard baseline; report every found surface as a deviation citing `file:line` for the most load-bearing block."
})
```

Wait for all four agents to return before continuing. Merge their reports into a single findings list keyed by file path. The merged list feeds Phase 2 scoring and Phase 3 drafting.

## Phase 2: Path-Scoped Rule Candidate Scoring

Adapt the `init-deep.ts:152-160` 8-factor matrix. The omo version scored subdirectories for `AGENTS.md` hierarchy placement; we recast each factor for path-scoped rule semantics (`.claude/rules/<topic>.md` with `paths:` frontmatter).

For every subdirectory `D` of the project, up to depth `MAX_DEPTH` (root is depth 0; root itself never becomes a path-scoped rule, it becomes the root `CLAUDE.md`), compute these factor scores from the Phase 1 findings:

1. **Tooling footprint**: distinct linter, formatter, type-checker, or test-runner configs scoped to `D`. Each adds 2 points.
2. **Language divergence**: `D` uses a language or framework version that differs from the project root. Adds 3 points when true.
3. **Convention density**: count of style or layout rules from agent 3 that fire only inside `D`. Each rule adds 1 point, capped at 5.
4. **Off-limits surface**: `D` contains generated, vendored, or migration files Claude must not edit. Adds 4 points.
5. **Test pairing**: `D` has a sibling test layout the model must mirror (Laravel `tests/Feature`, Go `_test.go`, Flutter `test/`). Adds 2 points.
6. **External-tool overlap**: agent 4 found a pre-existing rule surface (`AGENTS.md`, `.cursor/rules/`, copilot instructions) scoped under `D`. Adds 3 points when true.
7. **Hot-path frequency**: `D` is referenced by build, run, or CI scripts more than once. Adds 2 points.
8. **Compaction sensitivity**: a rule in `D` must hold across `/compact`. Subtracts 3 points (path-scoped rules summarize away after compact; high-sensitivity rules belong in root CLAUDE.md instead).

Thresholds, inherited from `init-deep.ts:152-160` and carried forward as starting values that need empirical tuning on real projects:

- Score `> 15`: strong candidate. Emit a `.claude/rules/<topic>.md` with `paths:` covering the subdirectory.
- Score `8` to `15`: borderline. Hold for the post-clip review.
- Score `< 8`: drop.

Clip the candidate list:

1. Drop every candidate whose depth exceeds `MAX_DEPTH`.
2. Cap the surviving list at 5 entries, keeping the highest-scoring 5.

When clipping drops one or more candidates that scored above the strong threshold, surface the drop list via `AskUserQuestion` (header "Drop rules?", question "These path-scoped rule candidates scored strongly but were clipped by depth or by the max-5 cap. Drop them or include them?", options: list the candidates as "Keep <topic>" entries plus a final "Drop all clipped" option). Apply the user's choice before continuing to Phase 3.

Note inline that the thresholds and factor weights are starting values. Tune them on the first three real projects before treating them as final.

## Phase 3: Draft and Write

### 3a. Invoke the writing skill (once, at phase entry)

Before drafting any file, invoke the writing skill exactly once:

```
Skill({skill: "ac:claude-md-rules-creator"})
```

The skill body becomes the playbook for the rest of this phase. Treat its pre-flight checklist at `SKILL.md:336-361` as the gate every emitted file must pass before the `Write` or `Edit` call.

### 3b. Draft the root `CLAUDE.md`

Lead with the canonical preface from the skill body. The five-question frame (stack, where code lives, how to run things, conventions, off-limits) drives section selection. Pull content from the Phase 1 deviations and the Phase 0c interview answers; never restate language defaults or anything the linter and formatter already enforce.

Length budget: aim for 40 to 80 lines (the sweet spot the writing skill cites at `SKILL.md:344`). Hard ceiling 200 lines. When the draft exceeds 80 lines, move topic content into `.claude/rules/<topic>.md` files rather than padding the root file.

Run the pre-flight checklist at `SKILL.md:336-361` against the draft. The checklist covers layered-context audit, attribution comment, scope correctness, line budget, the "removing this would cause mistakes" test, specificity, no aspirations, no standard-language conventions, no aggressive `CRITICAL` / `MUST` / `ALWAYS` repetition, and the canonical preface for project-team files. Resolve every unchecked box before writing.

### 3c. Draft `CLAUDE.local.md` (skip when `--no-local`)

When `WRITE_LOCAL=false`, skip drafting. The 0b gitignore guard already ran when an existing file is present; nothing else fires.

When `WRITE_LOCAL=true`, draft the personal companion. Content is per the writing skill's CLAUDE.local body recipe: the user's role, sandbox URLs, test accounts (pointers, never credentials), communication preferences. Honor the 1a worktree branch: for sibling or external worktrees, write the personal content to `~/.claude/<PROJECT_SLUG>-instructions.md` and make `CLAUDE.local.md` a one-line stub `@~/.claude/<PROJECT_SLUG>-instructions.md`.

Run the pre-flight checklist at `SKILL.md:336-361` before writing. Length budget: same 40 to 80 line sweet spot, 200 hard ceiling.

### 3d. Draft up to five `.claude/rules/*.md`

For each surviving Phase 2 candidate (max 5), draft a focused rule file at `<PATH_ARG>/.claude/rules/<topic>.md` with `paths:` frontmatter per `SKILL.md:266-281`. Topic name follows the convention in the writing skill: lowercase, hyphen-separated, one focused subject.

Length budget per rule: 30 to 80 lines sweet spot, 200 hard ceiling. When a draft exceeds 80 lines, split the topic before writing.

Run the pre-flight checklist at `SKILL.md:336-361` against each rule draft. The path-scoped-specific items at the bottom of the checklist matter most here: glob actually matches your intent, no `paths: ['**']`.

### 3e. Existing-file safety and dry-run handling

For every target file (`CLAUDE.md`, `CLAUDE.local.md`, each rule):

1. When `DRY_RUN=true`: print the intended write target path, the line count of the draft, and the first 20 lines of the draft. Do not call `Write` or `Edit`. After all targets have been printed, exit Phase 3 and skip Phase 4 verification of unwritten files (verification has nothing to read).
2. When the target file does not exist: pass the pre-flight checklist, then call `Write`.
3. When the target file exists and `FORCE_OVERWRITE=true`: pass the pre-flight checklist, then call `Edit` (or `Write` for a full replacement when the existing content is being fully superseded).
4. When the target file exists and `FORCE_OVERWRITE=false`: write the draft to `<target>.proposed` (for example `CLAUDE.md.proposed`, `.claude/rules/api.md.proposed`). Then ask via `AskUserQuestion` (header "Apply?", question "`<target>` already exists. The proposed draft is at `<target>.proposed`. How should this file be handled?", options "Apply (overwrite original)", "Skip (leave original, keep `.proposed` for review)", "Edit (open the proposed file for manual edits, then re-run with `--force-overwrite`)"). Apply the user's choice. On "Apply", `Edit` or `Write` the original file with the proposed content and delete the sidecar. On "Skip", leave both files in place. On "Edit", leave the sidecar in place and print a one-line instruction to re-run the command with `--force-overwrite` after the manual edits.

## Phase 4: Read-Back, Dedupe, and Report

### 4a. Read every emitted file

`Read` each file actually written or proposed in Phase 3. For `--dry-run` runs there is nothing to read; skip to 4d and emit a summary stating that the run was a dry run.

### 4b. Parent-vs-child dedupe pass

Mirror `init-deep.ts:262-271`. For each line in a `.claude/rules/<topic>.md` file, check whether the same fact or near-paraphrase exists in the root `CLAUDE.md`. When a duplicate is found:

1. Keep the version in the more specific scope. A path-scoped rule for `src/api/**` keeps the rule; the root file drops it.
2. When the parent is more specific (the rule is a vague restatement), keep the parent and drop the child line.

Apply the dedupe pass by `Edit`ing the affected files. Run the pre-flight checklist again on any file the dedupe pass touched.

### 4c. Anti-pattern check

For every emitted file, scan against principles 8 and 9 at `SKILL.md:117-118`. Principle 8 forbids aggressive `CRITICAL` / `MUST` / `ALWAYS` repetition in the file body; the runtime already prepends `MEMORY_INSTRUCTION_PROMPT`. Principle 9 requires no duplication with the CC built-in system prompt or with another loaded layer.

When a violation is found, fix it in place with `Edit` and re-run the pre-flight checklist on the affected file.

### 4d. Per-file summary

Emit a plain-text summary, one block per file, in this shape:

```
<absolute-path>
  lines: <count>
  sections: <comma-separated H2 headings>
  anti-pattern check: <pass | <one-line description of remaining issue>>
```

End the report with a single-line "next step" pointer: when proposed sidecars remain, suggest re-running with `--force-overwrite` after review; when everything was applied, suggest running `/memory` inside the target project to confirm the loader picked up the new files.

## References

Canonical anchors used by this command body. Cross-check before editing.

- `references/claude-code-cli-source-code/commands/init.ts:30-43` (CC native `/init` Phase 1 interview shape).
- `references/claude-code-cli-source-code/commands/init.ts:56,150` (worktree sibling-vs-nested disambiguation).
- `references/claude-code-cli-source-code/commands/init.ts:139` (gitignore guard for `CLAUDE.local.md`).
- `init-deep.ts:38-54` (omo "predict standard, report only deviations" discovery brief style).
- `init-deep.ts:152-160` (omo 8-factor scoring matrix and `>15 / 8-15 / <8` thresholds).
- `init-deep.ts:262-271` (omo parent-vs-child dedupe pass).
- `plugins/ac/skills/claude-md-rules-creator/SKILL.md:117-118` (principles 8 and 9: no aggressive caps, no duplication with existing layers).
- `plugins/ac/skills/claude-md-rules-creator/SKILL.md:266-281` (path-scoped rule shape with `paths:` frontmatter).
- `plugins/ac/skills/claude-md-rules-creator/SKILL.md:336-361` (pre-flight checklist applied before every `Write` or `Edit`).
- `plugins/ac/commands/plan.md:7-10` (intro cadence mirrored above).
- `plugins/ac/commands/work.md:17-23` (CAN / CANNOT / MUST orchestrator block shape).
