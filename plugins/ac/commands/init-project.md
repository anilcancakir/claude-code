---
description: "Set up a project's CLAUDE.md, CLAUDE.local.md and path-scoped rules from a codebase scan and a short interview, then wire and prove a linter hook and a language server."
argument-hint: "[path] [--max-depth=N] [--dry-run] [--no-local] [--force-overwrite]"
effort: medium
disable-model-invocation: true
---

# /ac:init-project

Deep project investigation followed by an optimized CLAUDE.md, optional CLAUDE.local.md, up to five path-scoped `.claude/rules/*.md` files, a linter hook that provably fires, and a language server that provably answers. Drives the `ac:claude-md-rules-creator` skill as the writing playbook.

Request: $ARGUMENTS

Do NOT call `EnterPlanMode` or `ExitPlanMode`; both are deny-ruled by the overlay. This command runs on the main thread and uses no plan mode.

## Phase 0: Identity, Arguments, Primer, and Existing-File Branch

You are the `/ac:init-project` orchestrator. You investigate a target project, decide what standing instructions belong in which file shape, and leave the project with those files plus working tooling. You run on the main thread; the four discovery agents in Phase 1 are subagents you spawn.

**CAN**: Use `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `LSP`, `AskUserQuestion`. Spawn `Agent` with `subagent_type: "ac:explore"` for codebase fan-out. Invoke the `ac:claude-md-rules-creator` skill at Phase 3 entry (see the exact call in section 3a). Write `<target>.proposed` sidecar files when an existing target would be overwritten. Write `.claude/hooks/lint-changed.sh` and merge one hook entry into `.claude/settings.local.json` inside the target project (Phase 4). Merge one `enabledPlugins` key into `~/.claude/settings.json` after the Phase 5 proposal is approved.

**CANNOT**: Spawn `ac:librarian` or `ac:oracle` from this command; the surface is limited to `ac:explore` for codebase discovery. `ac:explore` cannot spawn anything, because its `tools:` allowlist omits `Agent`; every discovery agent returns to this orchestrator before the next step. Author CLAUDE.md prose without first invoking `ac:claude-md-rules-creator`. Edit files outside the target project directory, with one exception: the `enabledPlugins` key of `~/.claude/settings.json` in Phase 5. Interview the user about MCP servers or about settings keys generally; the only non-CLAUDE.md surfaces this command touches are the Phase 4 linter hook and the Phase 5 language server, each behind its own question. Write a hook into `.claude/settings.json` unless the 4b promotion question was answered with the promote option. Repair a pre-existing malformation in a settings file this command did not create.

**MUST**: Apply argument precedence: when both `--dry-run` and `--force-overwrite` are set, `--dry-run` wins and no `Write` or `Edit` fires. Spawn the four Phase 1 discovery agents in a single parallel block. Invoke the writing skill exactly once at the very start of Phase 3. Run the pre-flight checklist at `SKILL.md:335-365` before every `Write` (new file) or `Edit` (existing file). Cap the root `CLAUDE.md` and rule files within the line budgets stated in Phase 3. Take a timestamped backup before every settings merge, and restore it when a post-write check fails.

### 0a. Parse arguments

1. Default `PATH_ARG` to the current working directory when no positional path is given; otherwise treat the first non-flag token as `PATH_ARG`. Resolve to an absolute path before any tool call.
2. `--max-depth=N`: parse the integer after `=`. Default `MAX_DEPTH=2`. Reject negative values; treat `0` as "root only". It bounds how deep a path-scoped rule's glob may be rooted in Phase 2c.
3. `--dry-run`: set `DRY_RUN=true` if present.
4. `--no-local`: set `WRITE_LOCAL=false` if present; otherwise `WRITE_LOCAL=true`.
5. `--force-overwrite`: set `FORCE_OVERWRITE=true` if present.
6. Precedence rule: if `DRY_RUN` and `FORCE_OVERWRITE` are both true, set `FORCE_OVERWRITE=false` for the rest of the run. `--dry-run` always wins; it prints intended writes and runs no command with a side effect.
7. Derive `PROJECT_SLUG` from the basename of `PATH_ARG`: lowercase, replace runs of non-alphanumeric characters with a single hyphen, strip leading and trailing hyphens. Used only in user-facing messages and in the optional sibling-worktree stub filename (`~/.claude/<PROJECT_SLUG>-instructions.md`).

### 0b. Primer, then the existing-file branch

Print a short plain-language primer before the first question, in four lines: `CLAUDE.md` is read at the start of every session in this project, so it costs tokens on every request and earns them back only where Claude would otherwise get something wrong; `CLAUDE.local.md` is the same file for you alone and is gitignored; `.claude/rules/<topic>.md` with `paths:` loads only when Claude reads a matching file; a hook is the only one of the four that runs code. Then say the run will ask one question at a time and that any answer can be "skip".

Check for `<PATH_ARG>/CLAUDE.md` with `test -f` first, then `Read` it only on a hit; `Read` on a missing path returns an error rather than an empty result. When it exists, ask before anything else:

```
AskUserQuestion({
  header: "Existing?",
  question: "<PATH_ARG>/CLAUDE.md already exists (<N> lines). How should this run treat it?",
  options: [
    {label: "Review and improve", description: "Keep the file as the base. Every change lands as a proposed diff against it, never a rewrite."},
    {label: "Leave it", description: "Do not touch CLAUDE.md. Rules, linter hook and language server still run."},
    {label: "Start fresh", description: "Draft a new CLAUDE.md from scratch; the current one goes through the .proposed gate in 3e before anything is overwritten."}
  ]
})
```

Record the answer as `MODE`. On `leave`, Phase 3b is skipped entirely. On `improve`, Phase 3b produces `Edit` diffs against the existing file rather than a fresh draft, and the pre-flight checklist runs against the merged result. When no `CLAUDE.md` exists, set `MODE=fresh` and ask nothing.

### 0c. Preference queue

Open one typed record and carry it through every later phase. Every interview answer writes exactly one field; a skipped question leaves the field `null` and the writing phase omits that section rather than inventing content.

```
PREFS = {
  mode: "improve" | "leave" | "fresh",
  scope: "project" | "personal" | "both",
  commands: {dev, build, test, lint, typecheck},
  golden_rules: [],          // at most 5 strings, each grep- or review-checkable
  testing: {command, single, quirks},
  offlimits: [],
  git: {branch_pattern, pr_rule},
  linter: {tool, target, promoted},
  lsp: {plugin, marketplace}
}
```

### 0d. Gitignore guard for `CLAUDE.local.md`

Claude Code's own `/init` adds `CLAUDE.local.md` to `.gitignore` when it writes one; this mirrors that. Run only when `WRITE_LOCAL=true`, or when a `CLAUDE.local.md` already exists at the target root and `WRITE_LOCAL=false` (the file exists, so we still want it ignored).

In `PATH_ARG`:

1. If `git rev-parse --git-dir` exits non-zero, skip the guard.
2. Otherwise run `git check-ignore -q CLAUDE.local.md`. On non-zero exit, append a `CLAUDE.local.md` line to `<PATH_ARG>/.gitignore` (create the file if missing). Print a one-line note: "Added CLAUDE.local.md to .gitignore so personal instructions stay local."

The guard is idempotent. Apply on every invocation; the `git check-ignore` short-circuits when the file is already ignored. Under `--dry-run`, run the two checks and print the line that would be appended, but append nothing.

## Phase 1: Codebase Discovery

### 1a. Worktree disambiguation

Run one `Bash` call: `git -C <PATH_ARG> worktree list`. When the output contains more than one worktree row, ask the user to disambiguate via `AskUserQuestion` (header "Worktrees?", question "Multiple git worktrees detected. Where do your sibling worktrees live relative to the main repo?", options "Nested inside main repo (e.g., `.claude/worktrees/<name>/`)", "Sibling or external (e.g., `../<repo>-feature/`)", "Single worktree, ignore"). The choice routes `CLAUDE.local.md` placement the way Claude Code's own `/init` does: nested worktrees inherit the main repo's `CLAUDE.local.md` via the upward walk; sibling worktrees need a `~/.claude/<PROJECT_SLUG>-instructions.md` file with a one-line `@~/.claude/<PROJECT_SLUG>-instructions.md` stub per worktree.

Skip the question when only one worktree row is reported.

### 1b. Four parallel `ac:explore` agents

Spawn exactly four discovery agents in a single response, targeting `PATH_ARG` (not this repository). Each brief follows the "predict the standard answer first, report only the deviations" style borrowed from oh-my-openagent's `init-deep` skill (linked under References), and each carries its own `DEPTH` and `BUDGET` line so the agent does not fall back to its default and search wider than the angle needs.

```
Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 1 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard manifest and build setup for this kind of project, then report only deviations.\n\nCONTEXT: We are authoring CLAUDE.md for this project. Standing instructions only need to capture what Claude cannot already infer from the manifest.\n\nGOAL: Decide which build, test, lint, type-check, and run commands belong in CLAUDE.md, plus which linter binary the Phase 4 hook should call.\n\nDEPTH: shallow. The manifests answer this directly; do not read application source.\nBUDGET: one pass over the root plus any workspace package manifests, then report.\n\nDOWNSTREAM: Phase 3 will feed these findings to `ac:claude-md-rules-creator`. Standard commands (`pnpm test`, `cargo test`, `pytest`) get dropped; non-standard or wrapped commands stay.\n\nREQUEST: Read every manifest, lockfile, Makefile, justfile, and CI config in the project root. Predict the conventional command set for the detected stack in one line. List the deviations as `file:line` citations: custom scripts, wrapped commands, required pre-steps, environment bootstrap. Name the linter and its on-disk path (`node_modules/.bin/`, `vendor/bin/`, `.venv/bin/`) when one is installed. Skip standard commands the model already knows."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 2 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard language and framework set, then report only deviations.\n\nCONTEXT: We are deciding which framework facts deserve a CLAUDE.md line. Language defaults the model already knows do not.\n\nGOAL: Identify languages, framework versions, runtimes, and package managers in active use, plus the file-extension histogram Phase 5 matches against language-server manifests.\n\nDEPTH: medium. Version pins and config files, plus the top of a representative source file per language.\nBUDGET: two passes, the second only to resolve a version that the first pass left ambiguous.\n\nDOWNSTREAM: Phase 3 writes the stack paragraph from the deviations; Phase 5 matches the extension histogram against installed language-server plugins.\n\nREQUEST: Read manifest version pins, framework config files (next.config, vite.config, tsconfig, pyproject, build.gradle, etc.), and the top of representative source files. Predict the conventional stack profile in one line. List the deviations as `file:line` citations: pinned major versions that gate features, custom resolver setups, framework-specific conventions that diverge from defaults. End with a count of tracked files per extension, from `git ls-files`, for the top five extensions."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 3 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard code style and report only deviations.\n\nCONTEXT: We are picking the style rules CLAUDE.md needs to encode. Defaults the linter and formatter already enforce do not belong in CLAUDE.md.\n\nGOAL: Identify formatter, linter, type-checker configuration plus any naming, layout, or testing conventions the team enforces by convention rather than by tool, and note for each whether it applies project-wide or only under one directory.\n\nDEPTH: deep. This is the angle that decides both the conventions section and every path-scoped rule, so it earns the widest read of the four.\nBUDGET: three passes, ending when a pass adds no convention the previous one missed.\n\nDOWNSTREAM: Phase 2c routes each convention you report to the root CLAUDE.md, to a hook, or to a path-scoped rule, so the scope note on each finding decides its destination.\n\nREQUEST: Read `.editorconfig`, `.prettierrc`, `.eslintrc*`, `biome.json`, `ruff.toml`, `pyproject.toml` tool tables, `.golangci.yml`, `phpstan.neon`, `pint.json`, plus 2 or 3 representative source files per detected language. Predict the conventional style profile in one line. List the deviations as `file:line` citations: rules the tooling does not catch, naming patterns, file layout conventions, test-file pairing rules. Mark each one `project-wide` or `only under <dir>`, and flag any whose violation would cost data, secrets, or a broken main branch."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 4 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard agent-infra footprint and report only deviations.\n\nCONTEXT: We are deciding whether the new CLAUDE.md should import existing agent-tool instructions via `@path` rather than restate them.\n\nGOAL: Inventory every pre-existing agent-tool instruction surface in the project, plus any settings file this run would have to merge into.\n\nDEPTH: shallow. This is an inventory, not an analysis; one line of summary per file found is enough.\nBUDGET: one pass over the known paths, then report. A clean empty set is a useful answer; say so rather than widening the search.\n\nDOWNSTREAM: Phase 3 will either `@import` these files or migrate their content into focused `.claude/rules/*.md` topics. Phase 4 needs to know whether a settings file already exists and whether it already carries hooks.\n\nREQUEST: Check for `AGENTS.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, `.mcp.json`, existing `CLAUDE.md`, existing `.claude/rules/*.md`, existing `.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`. For each, report path, line count, and a one-line summary. For the two settings files, report whether `jq .` parses them and whether they already carry a `hooks.PostToolUse` entry. Predict the empty set as the standard baseline; report every found surface as a deviation citing `file:line` for the most load-bearing block."
})
```

Wait for all four agents to return before continuing. Merge their reports into a single findings list keyed by file path. The merged list feeds the Phase 2 interview and placement pass.

## Phase 2: Gap-Fill Interview and Placement

### 2a. Interview protocol

Ask one question per `AskUserQuestion` call. Bundling saves a round-trip and costs the conditional logic: the answer to the scope question decides whether the personal questions are asked at all. Skip any question the Phase 1 findings already answered with a citation; say which finding answered it instead of asking.

Mark an option `(Recommended)` only where the question has a factually correct answer, for example the target file for a hook. Never mark one on a question about how the team works or what the user prefers; a recommendation there is a nudge toward the answer that is easiest to write, not the true one.

Every answer writes its `PREFS` field before the next question is asked, so an interrupted run leaves a partial queue rather than nothing.

### 2b. The question nodes

In order, skipping any the Phase 1 findings resolved:

1. **Scope**: which files this run should produce (project `CLAUDE.md`, personal `CLAUDE.local.md`, both). Skip when `--no-local` already decided it.
2. **Commands**: confirm the command set agent 1 found, or correct it. Present the found commands in the option descriptions so the user is confirming text, not recalling it.
3. **Golden rules**: the rules a reviewer would reject a PR over. At most five, each one checkable by grep or by review. Reject a vague answer back to the user once ("Write clean code" is not checkable; ask what a reviewer would grep for). This fills `## Golden Rules` in the template; when the user has none, the section is omitted rather than filled with filler.
4. **Testing**: the test command, how to run a single test file or case, and any prerequisite (a `.env.test`, a running database, a seeded fixture). This fills `## Testing`.
5. **Off-limits**: paths Claude must not edit (generated code, migrations, vendored trees), each with what to do instead.
6. **Git**: branch naming and PR rules, when the repository history does not already show them.

### 2c. The placement rule

Every candidate convention, from the Phase 1 findings and from the interview, goes through two questions in this order. Answer both before writing anything, and record the branch each one took.

1. **Does this apply only to files matching a specific pattern?** No means the root `CLAUDE.md`. A convention that holds project-wide in a file scoped to `src/api/**` is a convention that is silent for most of the session.
2. **Is it safety-critical?** A convention whose violation costs data, secrets, or a broken main branch is safety-critical. Yes means the root `CLAUDE.md`, which loads unconditionally at session start, or a `PreToolUse` hook when it has to actually block. Never a path-scoped rule: those load only when Claude uses the native `Read` tool on a matching file, `Edit` and `Write` do not trigger them, and both anthropics/claude-code#82482 and #90449 are open against exactly that behaviour. The official rules documentation says the same thing in its own words, that a rule is context rather than enforced configuration; a `PreToolUse` hook is the mechanism for anything that must block.

Only a convention that is pattern-specific and not safety-critical becomes a `.claude/rules/<topic>.md` file with `paths:` frontmatter. Cap the emitted rule files at 5, keep each glob rooted no deeper than `MAX_DEPTH`, and when more than five survive, ask the user which five to keep (header "Which rules?", one option per candidate plus "Keep the first five").

The reasoning is part of the output, not a private step. Each emitted rule file carries a one-line block-level HTML comment naming the branch it took (stripped at injection, so it costs the model nothing and stays visible to a human), and the Phase 6 report lists every convention with its destination and the question that sent it there.

## Phase 3: Draft and Write

### 3a. Invoke the writing skill (once, at phase entry)

Before drafting any file, invoke the writing skill exactly once:

```
Skill({skill: "ac:claude-md-rules-creator"})
```

The skill body becomes the playbook for the rest of this phase. Treat its pre-flight checklist at `SKILL.md:335-365` as the gate every emitted file must pass before the `Write` or `Edit` call.

### 3b. Draft the root `CLAUDE.md` (skip when `MODE=leave`)

Lead with the canonical preface from the skill body. The five-question frame (stack, where code lives, how to run things, conventions, off-limits) drives section selection, extended by the `## Golden Rules` and `## Testing` sections the template carries. Pull content from the Phase 1 deviations and the `PREFS` queue; never restate language defaults or anything the linter and formatter already enforce.

When `MODE=improve`, do not draft a replacement. Produce one `Edit` per improvement against the existing file, each with a one-line reason, and show the set as a diff before applying it. The gate in 3e applies to the merged result.

Length budget: aim for 60 to 120 lines (the sweet spot the writing skill cites at `SKILL.md:344`, measured across eight production repositories). Hard ceiling 200 lines. When the draft exceeds 120 lines, move topic content into `.claude/rules/<topic>.md` files rather than padding the root file.

Run the pre-flight checklist at `SKILL.md:335-365` against the draft and resolve every unchecked box before writing.

### 3c. Draft `CLAUDE.local.md` (skip when `--no-local`)

When `WRITE_LOCAL=false`, skip drafting. The 0d gitignore guard already ran when an existing file is present; nothing else fires.

When `WRITE_LOCAL=true`, draft the personal companion. Content is per the writing skill's CLAUDE.local body recipe: the user's role, sandbox URLs, test accounts (pointers, never credentials), communication preferences. Honor the 1a worktree branch: for sibling or external worktrees, write the personal content to `~/.claude/<PROJECT_SLUG>-instructions.md` and make `CLAUDE.local.md` a one-line stub `@~/.claude/<PROJECT_SLUG>-instructions.md`.

Run the pre-flight checklist at `SKILL.md:335-365` before writing. Length budget: same 60 to 120 line sweet spot, 200 hard ceiling.

### 3d. Draft up to five `.claude/rules/*.md`

For each convention that took the rule branch in 2c, draft a focused rule file at `<PATH_ARG>/.claude/rules/<topic>.md` with `paths:` frontmatter per `SKILL.md:266-281`. Topic name follows the convention in the writing skill: lowercase, hyphen-separated, one focused subject.

Length budget per rule: 30 to 80 lines sweet spot, 200 hard ceiling. When a draft exceeds 80 lines, split the topic before writing.

Run the pre-flight checklist at `SKILL.md:335-365` against each rule draft. The path-scoped items at the bottom of the checklist matter most here: the glob actually matches your intent, and no `paths: ['**']`, which the loader treats as no `paths:` at all.

### 3e. Existing-file safety and dry-run handling

For every target file (`CLAUDE.md`, `CLAUDE.local.md`, each rule):

1. When `DRY_RUN=true`: print the intended write target path, the line count of the draft, and the first 20 lines of the draft. Do not call `Write` or `Edit`. After all targets have been printed, exit Phase 3 and continue to Phase 4; both Phase 4 and Phase 5 have their own dry-run branch that prints the plan and writes nothing, and Phase 6 then reports the run as a dry run.
2. When the target file does not exist: pass the pre-flight checklist, then call `Write`.
3. When the target file exists and `FORCE_OVERWRITE=true`: pass the pre-flight checklist, then call `Edit` (or `Write` for a full replacement when the existing content is being fully superseded).
4. When the target file exists and `FORCE_OVERWRITE=false`: write the draft to `<target>.proposed` (for example `CLAUDE.md.proposed`, `.claude/rules/api.md.proposed`). Then ask via `AskUserQuestion` (header "Apply?", question "`<target>` already exists. The proposed draft is at `<target>.proposed`. How should this file be handled?", options "Apply (overwrite original)", "Skip (leave original, keep `.proposed` for review)", "Edit (open the proposed file for manual edits, then re-run with `--force-overwrite`)"). Apply the user's choice. On "Apply", `Edit` or `Write` the original file with the proposed content and delete the sidecar. On "Skip", leave both files in place. On "Edit", leave the sidecar in place and print a one-line instruction to re-run the command with `--force-overwrite` after the manual edits.

## Phase 4: Linter Hook

A CLAUDE.md line asking for a lint run is a request; a hook is the thing that runs. Follow the seven-step procedure, the script and the three proofs in `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/hook-wiring.md`; do not re-derive them here. Skip this phase when Phase 1 found no linter installed on disk, and say so.

### 4a. Ask before running anything

One `AskUserQuestion` covers the whole phase (header "Lint hook?", question "Wire a PostToolUse hook that runs `<resolved linter path>` on files Claude writes, and reports failures back into the session?", options "Yes, wire and verify it", "No, skip"). The option text states what the hook cannot do: it runs after the write lands, so it reports rather than blocks, and it does not fire when a `Bash` command rewrites the same file. Take the executable name from the Phase 1 finding and bake it into the script as a literal; repository content never names the executable.

### 4b. Default target, and the promotion question

The default target is `<PATH_ARG>/.claude/settings.local.json`. Ask about promotion separately, and only after the user has agreed to the hook at all:

```
AskUserQuestion({
  header: "Which file?",
  question: "Where should the hook be registered?",
  options: [
    {label: "settings.local.json (Recommended)", description: "Your machine only. Nothing runs on a teammate's checkout, and the file is gitignored in the same step."},
    {label: "settings.json", description: "Committed to the repository. The hook then runs on every teammate's machine and in every -p and CI session, with no trust prompt."}
  ]
})
```

Record the answer in `PREFS.linter.target` and `PREFS.linter.promoted`. A write to `.claude/settings.json` happens only when this question returned the second option.

When the target file does not exist, create it containing `{}` in the same step that adds its name to `<PATH_ARG>/.gitignore`; Claude Code gitignores `settings.local.json` only when it saves a setting there itself. The `{}` is not cosmetic and `install.md:221` already uses it: `jq` on a zero-byte file exits 0 and prints nothing, so the merge below would `mv` an empty file into place and lose both the settings and the hook without an error.

### 4c. Guard the write

In order, stopping at the first failure:

1. `cp` the target to `<target>.bak.$(date +%Y%m%d%H%M%S)` when it exists.
2. `jq . <target>` when the file existed before this run. A non-zero exit means it was already malformed: stop, report the parse error and the path, and change nothing. Do not repair a malformation this command did not create. Say which way it fails: interactively Claude Code offers a fix dialog, while a `-p` or CI run skips the broken file or the broken values silently. Skip this step for a file 4b just created, whose contents are the `{}` you wrote.
3. Merge with the `jq` expression from `hook-wiring.md` into `<target>.tmp`, then `mv` it into place. Never hand-write the whole file with `Write`.
4. `jq -e` for the nesting, per the same reference: exit 0 with the command printed is correct, exit 4 means the matcher does not match, exit 5 means malformed JSON or wrong nesting.
5. `claude doctor` with the target project as the working directory.

Roll back when step 4 or step 5 fails, then report which step failed and what it printed. Rollback has two shapes: restore the backup when step 1 took one, and when 4b created the file this run, delete it and remove the `.gitignore` line instead. There is no backup to restore for a file that did not exist, and leaving a half-written one behind is worse than leaving none.

Under `--dry-run`, print the script, the merge expression and the target path, then stop: create no file, add no `.gitignore` entry, and run none of the five steps. The pipe-test and the live-fire proof both have side effects.

## Phase 5: Language Server

An LSP that answers turns `LSP findReferences` and `goToDefinition` into real tools for every later session in this project. Follow `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/lsp-wiring.md`: enumerate the installed marketplace manifests at runtime rather than consulting any table, prefer a plugin from `claude-plugins-official` and say so explicitly when falling back to a third-party marketplace, and refuse a proposal whose candidates declare overlapping extensions instead of silently disabling one of them.

1. Match the extension histogram from Phase 1 agent 2 against the `extensionToLanguage` maps the reference enumerates.
2. Propose at most one plugin per extension through a single `AskUserQuestion`, naming the marketplace each candidate comes from. Two legitimate candidates for one language is a choice to hand to the user, not something to resolve silently.
3. On approval, merge `enabledPlugins["<plugin>@<marketplace>"] = true` into `~/.claude/settings.json` through the same five guarded steps as 4c, with one substitution: step 4's assertion is `jq -e '.enabledPlugins["<plugin>@<marketplace>"]' ~/.claude/settings.json`, not 4c's hook selector. Reusing 4c's `.hooks.PostToolUse` expression here exits 4 on a settings file that carries no hooks, and step 4's failure path would then roll back a write that succeeded. When the marketplace holding the plugin is not installed, do not install it: print the `/plugin marketplace add` and `/plugin install` lines for the user to run, and stop the phase there.
4. Verify both parts the reference requires, because neither is sufficient alone: the plugin appears under `enabledPlugins`, and one real `LSP` `hover` or `documentSymbol` call against an existing file of that language answers. Name the server that replied. When part 1 passes and part 2 fails, report it as the missing server binary it is, not as a misconfiguration, and name the binary.

When the detected language is outside every installed marketplace's coverage, name that gap and stop. Authoring a `.lsp.json` means authoring a plugin, which is not a project-setup step.

Under `--dry-run`, print the matched candidates and the marketplace each comes from, and write nothing.

## Phase 6: Read-Back, Dedupe, and Report

### 6a. Read every emitted file

`Read` each file actually written or proposed in Phase 3. For `--dry-run` runs there is nothing to read; skip to 6d and emit a summary stating that the run was a dry run.

### 6b. Parent-versus-child dedupe pass

Mirror the parent-versus-child dedupe rule from `init-deep` (linked under References), which holds that a child file never repeats its parent. For each line in a `.claude/rules/<topic>.md` file, check whether the same fact or near-paraphrase exists in the root `CLAUDE.md`. When a duplicate is found:

1. Keep the version in the more specific scope. A path-scoped rule for `src/api/**` keeps the rule; the root file drops it.
2. When the parent is more specific (the rule is a vague restatement), keep the parent and drop the child line.

Apply the dedupe pass by `Edit`ing the affected files. Run the pre-flight checklist again on any file the dedupe pass touched.

### 6c. Anti-pattern check

For every emitted file, scan against principles 8 and 9 at `SKILL.md:117-118`. Principle 8 forbids aggressive `CRITICAL` / `MUST` / `ALWAYS` repetition in the file body; the runtime already prepends `MEMORY_INSTRUCTION_PROMPT`. Principle 9 requires no duplication with the CC built-in system prompt or with another loaded layer.

When a violation is found, fix it in place with `Edit` and re-run the pre-flight checklist on the affected file.

### 6d. Report

One block per emitted file:

```
<absolute-path>
  lines: <count>
  sections: <comma-separated H2 headings>
  anti-pattern check: <pass | <one-line description of remaining issue>>
```

Then the placement table, one row per convention: the convention, its destination (root `CLAUDE.md` / hook / `.claude/rules/<topic>.md`), and which of the two 2c questions sent it there. Then one line each for the linter hook (target file, whether the three proofs passed) and the language server (plugin, marketplace, which server answered the probe).

End with a single-line next step: when proposed sidecars remain, suggest re-running with `--force-overwrite` after review; otherwise suggest running `/memory` inside the target project to confirm the loader picked up the new files. When the live-fire hook proof failed while the pipe-test and `jq -e` passed, add the settings-watcher line from `hook-wiring.md` and point at `/hooks`.

## References

Provenance for whoever edits this body. Cross-check before changing the behaviour each one backs.

Reachable from an installed copy:

- `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/SKILL.md` (principles 8 and 9: no aggressive caps, no duplication with existing layers; the path-scoped rule shape with `paths:` frontmatter; the pre-flight checklist applied before every `Write` or `Edit`; the 60 to 120 line sweet spot with its eight-repository measurement).
- `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/hook-wiring.md` (Phase 4: the seven-step procedure, the script, the `settings.local.json` registration with the `jq` merge, the three proofs, and the settings-watcher caveat).
- `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/lsp-wiring.md` (Phase 5: runtime manifest enumeration, official-marketplace-first with explicit fallback, the overlap refusal, and the two-part verification).
- `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/rules-writing.md` (the load-on-read activation sequence behind the 2c placement rule: only the `Read` tool triggers a path-scoped rule, `Edit` and `Write` do not).
- `${CLAUDE_PLUGIN_ROOT}/commands/install.md` (CAN / CANNOT / MUST orchestrator block shape).
- oh-my-openagent's `init-deep` skill, pinned at [`b12d08f`](https://github.com/code-yeongyu/oh-my-openagent/blob/b12d08f4ba6c8ad33c2b4032e1445dc56df7868b/packages/shared-skills/skills/init-deep/SKILL.md): [L52-L56](https://github.com/code-yeongyu/oh-my-openagent/blob/b12d08f4ba6c8ad33c2b4032e1445dc56df7868b/packages/shared-skills/skills/init-deep/SKILL.md#L52-L56) and [L222](https://github.com/code-yeongyu/oh-my-openagent/blob/b12d08f4ba6c8ad33c2b4032e1445dc56df7868b/packages/shared-skills/skills/init-deep/SKILL.md#L222) for the "report only deviations from standard" discovery brief, and [L302](https://github.com/code-yeongyu/oh-my-openagent/blob/b12d08f4ba6c8ad33c2b4032e1445dc56df7868b/packages/shared-skills/skills/init-deep/SKILL.md#L302) for the parent-versus-child dedupe rule.

Not reachable from an installed copy, so the facts are stated inline in the body above rather than left as a lookup. Claude Code's native `/init` is the source for four of them: the primer plus existing-file branch in 0b, the one-question-at-a-time interview shape, the sibling-versus-nested worktree disambiguation, and the `CLAUDE.local.md` gitignore guard in section 0d. The only readable source for those is a local reverse-engineered mirror of the CLI, which has no public upstream, so do not add a path here expecting a reader to open it.

- `code.claude.com/docs/en/features-overview#build-your-setup-over-time` (official "build your setup over time" decision table: CLAUDE.md / skill / subagent / hook; the second question in 2c is that table's "you want it enforced every single time" row).
- anthropics/claude-code#82482 and #90449 (both open: path-scoped rules load on the native `Read` tool only, which is why 2c never routes a safety-critical convention into one).
