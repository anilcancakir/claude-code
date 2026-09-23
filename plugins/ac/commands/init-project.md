---
description: "Set up a project for Claude Code: CLAUDE.md, CLAUDE.local.md, path-scoped rules, permission rules, a proven lint or format hook and a language server, from a codebase scan, a short interview and one approved proposal."
argument-hint: "[path] [--max-depth=N] [--dry-run] [--no-local] [--force-overwrite] [--no-oracle]"
effort: medium
disable-model-invocation: true
---

# /ac:init-project

Deep project investigation followed by an optimized CLAUDE.md, optional CLAUDE.local.md, up to five path-scoped `.claude/rules/*.md` files, permission rules that keep secrets unreadable and routine commands unprompted, a lint or format hook that provably fires, and a language server that provably answers. Everything is shown as one proposal and approved once before anything is written, and the drafts pass one `ac:oracle` review before they land. Drives the `ac:claude-md-rules-creator` skill as the writing playbook.

Request: $ARGUMENTS

Do NOT call `EnterPlanMode` or `ExitPlanMode`. This command runs on the main thread and uses no plan mode; the plugin's `PreToolUse` hook steers native plan mode to `/ac:plan` anyway.

## Phase 0: Identity, Arguments, Primer, and Existing-File Branch

You are the `/ac:init-project` orchestrator. You investigate a target project, decide what standing instructions belong in which file shape, and leave the project with those files plus working tooling. You run on the main thread; the four discovery agents in Phase 1 and the Phase 3e reviewer are subagents you spawn.

**CAN**: Use `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `LSP`, `AskUserQuestion`. Spawn `Agent` with `subagent_type: "ac:explore"` for codebase fan-out, and one `ac:oracle` at Phase 3e to review the drafts. Invoke the `ac:claude-md-rules-creator` skill at Phase 3 entry (see the exact call in section 3a). Write `<target>.proposed` sidecar files when an existing target would be overwritten. Write one hook script under `.claude/hooks/` and merge its entry, plus the approved `permissions.deny` and `permissions.allow` rules, into the target project's `.claude/settings.json` or `.claude/settings.local.json` as the 2d proposal named (Phase 4). Merge one `enabledPlugins` key into `~/.claude/settings.json` after the 2d proposal is approved.

**CANNOT**: Spawn `ac:librarian`, or `ac:oracle` anywhere but 3e. `ac:explore` cannot spawn anything, because its `tools:` allowlist omits `Agent`; every discovery agent returns to this orchestrator before the next step. Author CLAUDE.md prose without first invoking `ac:claude-md-rules-creator`. Edit files outside the target project directory, with three exceptions: the `enabledPlugins` key of `~/.claude/settings.json` in Phase 5, `~/.claude/<PROJECT_SLUG>-instructions.md` in 3c for sibling worktrees, and the 3e scratch directory under `${TMPDIR:-/tmp}`. Interview the user about MCP servers or about settings keys generally, or write any settings key other than one `hooks.PostToolUse` entry, `permissions.deny` and `permissions.allow` in the project and one `enabledPlugins` key in `~/.claude/settings.json`. Write `permissions.defaultMode` in particular: `auto` and `bypassPermissions` are ignored in project and local settings since 2.1.257, and a mode is the user's choice, not the project's. Write anything to `.claude/settings.json` that the approved 2d proposal did not place there. Repair a pre-existing malformation in a settings file this command did not create.

**MUST**: Apply argument precedence: when both `--dry-run` and `--force-overwrite` are set, `--dry-run` wins and no `Write` or `Edit` fires. Spawn the four Phase 1 discovery agents in a single parallel block. Show the 2d proposal and take its approval before the first `Write`, `Edit` or settings merge. Invoke the writing skill exactly once at the very start of Phase 3. Run the pre-flight checklist at `SKILL.md:341-371` before every `Write` (new file) or `Edit` (existing file), except the one-line rule repairs 2d approved as they are. Cap the root `CLAUDE.md` and rule files within the line budgets stated in Phase 3. Take a timestamped backup before every settings merge, and restore it when a post-write check fails.

### 0a. Parse arguments

1. Default `PATH_ARG` to the current working directory when no positional path is given; otherwise treat the first non-flag token as `PATH_ARG`. Resolve to an absolute path before any tool call.
2. `--max-depth=N`: parse the integer after `=`. Default `MAX_DEPTH=2`. Reject negative values; treat `0` as "root only". It bounds how deep a path-scoped rule's glob may be rooted in Phase 2c.
3. `--dry-run`: set `DRY_RUN=true` if present.
4. `--no-local`: set `WRITE_LOCAL=false` if present; otherwise `WRITE_LOCAL=true`.
5. `--force-overwrite`: set `FORCE_OVERWRITE=true` if present.
6. `--no-oracle`: set `REVIEW=false` if present; otherwise `REVIEW=true`. It only skips the 3e review.
7. Precedence rule: if `DRY_RUN` and `FORCE_OVERWRITE` are both true, set `FORCE_OVERWRITE=false` for the rest of the run. `--dry-run` always wins; it prints intended writes and runs no command with a side effect.
8. Derive `PROJECT_SLUG` from the basename of `PATH_ARG`: lowercase, replace runs of non-alphanumeric characters with a single hyphen, strip leading and trailing hyphens. Used only in user-facing messages and in the optional sibling-worktree stub filename (`~/.claude/<PROJECT_SLUG>-instructions.md`).

### 0b. Primer, then the existing-file branch

Print a short plain-language primer before the first question, in five lines: `CLAUDE.md` is read at the start of every session in this project, so it costs tokens on every request and earns them back only where Claude would otherwise get something wrong; `CLAUDE.local.md` is the same file for you alone and is gitignored; `.claude/rules/<topic>.md` with `paths:` loads only when Claude reads a matching file; a hook is the only one of them that runs code, and a permission rule in `.claude/settings.json` stops Claude from doing something without any code. Then say the run will ask a few questions one at a time, show one proposal of everything it would write, and write nothing until that proposal is approved; any answer can be "skip".

Check for `<PATH_ARG>/CLAUDE.md` with `test -f` first, then `Read` it only on a hit; `Read` on a missing path returns an error rather than an empty result. When it exists, ask before anything else:

```
AskUserQuestion({
  header: "Existing?",
  question: "<PATH_ARG>/CLAUDE.md already exists (<N> lines). How should this run treat it?",
  options: [
    {label: "Review and improve", description: "Keep the file as the base. Every change lands as a proposed diff against it, never a rewrite."},
    {label: "Leave it", description: "Do not touch CLAUDE.md. Rules, permissions, the hook and the language server still run."},
    {label: "Start fresh", description: "Draft a new CLAUDE.md from scratch; the current one goes through the .proposed gate in 3f before anything is overwritten."}
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
  hook: {kind, tools, target},        // kind: "lint" | "format" | "format+lint"; tools baked into the script
  permissions: {deny: [], deny_target, allow: [], allow_target},
  lsp: {plugin, marketplace},
  skill_candidates: []                 // procedures from 2c, reported only
}
```

### 0d. Gitignore guard for `CLAUDE.local.md`

Claude Code's own `/init` adds `CLAUDE.local.md` to `.gitignore` when it writes one; this mirrors that. Run only when `WRITE_LOCAL=true`, or when a `CLAUDE.local.md` already exists at the target root and `WRITE_LOCAL=false` (the file exists, so we still want it ignored).

In `PATH_ARG`:

1. If `git rev-parse --git-dir` exits non-zero, skip the guard.
2. Otherwise run `git check-ignore -q CLAUDE.local.md` and set `NEEDS_IGNORE=true` when it exits 1 (not ignored yet), `false` when it exits 0. Append nothing here: the line is a 2d Files bullet, and 3f appends it with the other approved writes, printing "Added CLAUDE.local.md to .gitignore so personal instructions stay local."

The check is idempotent; `git check-ignore` short-circuits when the file is already ignored. Under `--dry-run` the 2d proposal shows the line that would be appended.

## Phase 1: Codebase Discovery

### 1a. Worktree disambiguation

Run one `Bash` call: `git -C <PATH_ARG> worktree list`. When the output contains more than one worktree row, ask the user to disambiguate via `AskUserQuestion` (header "Worktrees?", question "Multiple git worktrees detected. Where do your sibling worktrees live relative to the main repo?", options "Nested inside main repo (e.g., `.claude/worktrees/<name>/`)", "Sibling or external (e.g., `../<repo>-feature/`)", "Single worktree, ignore"). The choice routes `CLAUDE.local.md` placement the way Claude Code's own `/init` does: nested worktrees inherit the main repo's `CLAUDE.local.md` via the upward walk; sibling worktrees need a `~/.claude/<PROJECT_SLUG>-instructions.md` file and a `CLAUDE.local.md` stub per worktree that imports it.

Skip the question when only one worktree row is reported.

### 1b. Four parallel `ac:explore` agents

Spawn exactly four discovery agents in a single response, targeting `PATH_ARG` (not this repository). Each brief follows the "predict the standard answer first, report only the deviations" style borrowed from oh-my-openagent's `init-deep` skill (linked under References), and each carries its own `DEPTH` and `BUDGET` line so the agent does not fall back to its default and search wider than the angle needs.

```
Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 1 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard manifest and build setup for this kind of project, then report only deviations.\n\nCONTEXT: We are authoring CLAUDE.md for this project. Standing instructions only need to capture what Claude cannot already infer from the manifest.\n\nGOAL: Decide which build, test, lint, type-check, and run commands belong in CLAUDE.md, plus which linter and formatter binaries the Phase 4 hook could call.\n\nDEPTH: shallow. The manifests answer this directly; do not read application source.\nBUDGET: one pass over the root plus any workspace package manifests, then report.\n\nDOWNSTREAM: Phase 3 will feed these findings to `ac:claude-md-rules-creator`. Standard commands (`pnpm test`, `cargo test`, `pytest`) get dropped; non-standard or wrapped commands stay.\n\nREQUEST: Read every manifest, lockfile, Makefile, justfile, and CI config in the project root. Predict the conventional command set for the detected stack in one line. List the deviations as `file:line` citations: custom scripts, wrapped commands, required pre-steps, environment bootstrap. Name the linter and the formatter, each with its on-disk path (`node_modules/.bin/`, `vendor/bin/`, `.venv/bin/`), when installed. Skip standard commands the model already knows."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 2 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard language and framework set, then report only deviations.\n\nCONTEXT: We are deciding which framework facts deserve a CLAUDE.md line. Language defaults the model already knows do not.\n\nGOAL: Identify languages, framework versions, runtimes, and package managers in active use, plus the file-extension histogram Phase 5 matches against language-server manifests.\n\nDEPTH: medium. Version pins and config files, plus the top of a representative source file per language.\nBUDGET: two passes, the second only to resolve a version that the first pass left ambiguous.\n\nDOWNSTREAM: Phase 3 writes the stack paragraph from the deviations; Phase 5 matches the extension histogram against installed language-server plugins.\n\nREQUEST: Read manifest version pins, framework config files (next.config, vite.config, tsconfig, pyproject, build.gradle, etc.), and the top of representative source files. Predict the conventional stack profile in one line. List the deviations as `file:line` citations: pinned major versions that gate features, custom resolver setups, framework-specific conventions that diverge from defaults. End with a count of tracked files per extension, from `git ls-files`, for the top five extensions."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 3 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard code style and report only deviations.\n\nCONTEXT: We are picking the style rules CLAUDE.md needs to encode. Defaults the linter and formatter already enforce do not belong in CLAUDE.md.\n\nGOAL: Identify formatter, linter, type-checker configuration which of them formats in place (prettier, biome, ruff format, black, gofmt, rustfmt, pint, or a unified `format` script) and which only reports, decided from the config and the manifest scripts, never by running a tool (a `--version` check at most: a formatter run to see what it does rewrites the files), plus any naming, layout, or testing conventions the team enforces by convention rather than by tool, and note for each whether it applies project-wide or only under one directory.\n\nDEPTH: deep. This is the angle that decides both the conventions section and every path-scoped rule, so it earns the widest read of the four.\nBUDGET: three passes, ending when a pass adds no convention the previous one missed.\n\nDOWNSTREAM: Phase 2c routes each convention you report to the root CLAUDE.md, to a hook, or to a path-scoped rule, so the scope note on each finding decides its destination.\n\nREQUEST: Read `.editorconfig`, `.prettierrc`, `.eslintrc*`, `biome.json`, `ruff.toml`, `pyproject.toml` tool tables, `.golangci.yml`, `phpstan.neon`, `pint.json`, plus 2 or 3 representative source files per detected language. Predict the conventional style profile in one line. List the deviations as `file:line` citations: rules the tooling does not catch, naming patterns, file layout conventions, test-file pairing rules. Mark each one `project-wide` or `only under <dir>`, and flag any whose violation would cost data, secrets, or a broken main branch."
})

Agent({
  subagent_type: "ac:explore",
  run_in_background: true,
  prompt: "Discovery agent 4 of 4 for `/ac:init-project`. Target project: <PATH_ARG>. Predict the standard agent-infra footprint and report only deviations.\n\nCONTEXT: We are deciding whether the new CLAUDE.md should import existing agent-tool instructions via `@path` rather than restate them.\n\nGOAL: Inventory every pre-existing agent-tool instruction surface in the project, any settings file this run would have to merge into, and the secret-shaped files a `permissions.deny` rule should cover.\n\nDEPTH: shallow. This is an inventory, not an analysis; one line of summary per file found is enough.\nBUDGET: one pass over the known paths, then report. A clean empty set is a useful answer; say so rather than widening the search.\n\nDOWNSTREAM: Phase 3 imports an `AGENTS.md` with `@AGENTS.md` rather than restating it, and migrates the other tools' rules into focused `.claude/rules/*.md` topics. Phase 4 needs to know whether a settings file already exists and whether it already carries hooks.\n\nREQUEST: Check for `AGENTS.md`, `.claude/AGENTS.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `.devin/rules/`, `.windsurf/rules/`, `.windsurfrules`, `.clinerules`, `.mcp.json`, existing `CLAUDE.md`, existing `.claude/rules/*.md`, existing `.claude/CLAUDE.md`, subdirectory `CLAUDE.md` files (`git ls-files '*CLAUDE.md'`), `.claude/skills/`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`. For each, report path, line count, and a one-line summary. Flag every existing `.claude/rules/**/*.md` (rules are discovered recursively) that carries a `paths:` line but whose first bytes are not `---` (a comment, a title or a blank line above the frontmatter): Claude Code then ignores its `paths:` and loads it at every launch. For the two settings files, report whether `jq .` parses them, whether they already carry a `hooks.PostToolUse` entry, and the `permissions.allow` and `permissions.deny` rules they already hold. Also list, by path only and never with `Read`, `cat` or any other read of their contents (a hook denies the attempt), the secret-shaped files present in the project: `ls -a` of the root plus `git ls-files` and `git ls-files --others --exclude-standard` filtered to `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `credentials*.json`, `service-account*.json`, `config/master.key`, `auth.json`; mark `.env.example`, `.env.sample` and `.env.dist` as templates rather than secrets. Predict the empty set as the standard baseline; report every found surface as a deviation citing `file:line` for the most load-bearing block."
})
```

Wait for all four agents to return before continuing, by ending the turn with a one-line status: each completion arrives as a task-notification that starts your next turn. Never poll one with a `sleep` loop or by re-reading its output file. Merge their reports into a single findings list keyed by file path. The merged list feeds the Phase 2 interview and placement pass.

## Phase 2: Gap-Fill Interview and Placement

### 2a. Interview protocol

Ask one question per `AskUserQuestion` call. Bundling saves a round-trip and costs the conditional logic: the answer to the scope question decides whether the personal questions are asked at all. Skip any question the Phase 1 findings already answered with a citation; say which finding answered it instead of asking.

Mark an option `(Recommended)` only where the question has a factually correct answer, for example the target file for a hook. Never mark one on a question about how the team works or what the user prefers; a recommendation there is a nudge toward the answer that is easiest to write, not the true one.

Every answer writes its `PREFS` field before the next question is asked, so an interrupted run leaves a partial queue rather than nothing.

### 2b. The question nodes

In order, skipping any the Phase 1 findings resolved:

1. **Scope**: which files this run should produce (project `CLAUDE.md`, personal `CLAUDE.local.md`, both). Skip when `--no-local` already decided it. The answer sets `PREFS.scope` and `WRITE_LOCAL` (`false` for project only), and a project-only answer drops the `CLAUDE.local.md` bullet from 2d, and its `.gitignore` line too unless a `CLAUDE.local.md` already exists.
2. **Commands**: confirm the command set agent 1 found, or correct it. Present the found commands in the option descriptions so the user is confirming text, not recalling it.
3. **Golden rules**: the rules a reviewer would reject a PR over. At most five, each one checkable by grep or by review. Reject a vague answer back to the user once ("Write clean code" is not checkable; ask what a reviewer would grep for). This fills `## Golden Rules` in the template; when the user has none, the section is omitted rather than filled with filler.
4. **Testing**: the test command, how to run a single test file or case, and any prerequisite (a `.env.test`, a running database, a seeded fixture). This fills `## Testing`.
5. **Off-limits**: paths Claude must not edit (generated code, migrations, vendored trees), each with what to do instead.
6. **Git**: branch naming and PR rules, when the repository history does not already show them.

### 2c. The placement rule

Every candidate convention, from the Phase 1 findings and from the interview, goes through two questions in this order. Answer both before writing anything, and record the branch each one took.

1. **Does this apply only to files matching a specific pattern?** No means the root `CLAUDE.md`. A convention that holds project-wide in a file scoped to `src/api/**` is a convention that is silent for most of the session.
2. **Is it safety-critical?** A convention whose violation costs data, secrets, or a broken main branch is safety-critical. Yes means the root `CLAUDE.md`, which loads unconditionally at session start, or a `PreToolUse` hook when it has to actually block. Never a path-scoped rule: those load only when Claude uses the native `Read` tool on a matching file, so `Edit`, `Write`, `Grep`, `Glob` and a shell `cat` never load one (References has the evidence). A secret file is the common case, and its answer is the 2d deny rule.

A third outcome sits beside the two: a multi-step procedure (a deploy, a release checklist, a review routine) is neither a convention nor a rule. It belongs in a skill, which loads only when invoked, so list it as a skill candidate for the Phase 6 report instead of writing it into any file here.

Only a convention that is pattern-specific and not safety-critical becomes a `.claude/rules/<topic>.md` file with `paths:` frontmatter. `paths` is the only frontmatter field Claude Code reads from a rule; any other field is ignored without an error. Cap the emitted rule files at 5, keep each glob rooted no deeper than `MAX_DEPTH`, and when more than five survive, ask the user which five to keep (header "Which rules?", one option per candidate plus "Keep the first five").

The reasoning is part of the output, not a private step. Each emitted rule file carries a one-line block-level HTML comment naming the branch it took, placed directly after the closing `---` of its frontmatter and never above it (stripped at injection, so it costs the model nothing and stays visible to a human), and the Phase 6 report lists every convention with its destination and the question that sent it there.

### 2d. One proposal, one approval

Before any file is drafted, print everything the run would write as one list, then take one approval. This is the built-in `/init` flow's shape ("present a reviewable proposal before writing any files"): the user sees the whole setup at once instead of answering a question per surface, and nothing reaches disk before they have.

Build it from the Phase 1 findings, the `PREFS` queue and the 2c placement, one bullet per item, each naming its target file:

- **Files.** Each `CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/<topic>.md` the run would write or change, with a one-line summary, an estimated line count, the glob of each rule, `@AGENTS.md` when 3b or 3c will import one, the `.gitignore` line for `CLAUDE.local.md` when 0d set `NEEDS_IGNORE`, and the `.gitignore` line for `settings.local.json` when any approved item targets that file and 4a would create it, and the `.gitignore` line for the hook script when its registration is local, so a teammate's checkout does not carry a script nothing on their machine runs.
- **Permissions.** Skip any rule the settings files already hold.
  - `permissions.deny` in `.claude/settings.json` (team-shared: deny beats allow in every file, so it protects every teammate), one `Read` rule per secret shape agent 4 found. A bare filename matches at any depth (`Read(.env)`, `Read(*.pem)`), a directory takes `Read(secrets/**)`, and a template the shape also catches is carved out by a negation listed after it (`Read(.env.*)` then `Read(!.env.example)`). Say in the bullet that this blocks Claude's file tools and `cat`-style shell reads but not `grep -r` or a script, so the file is guarded, not sealed.
  - `permissions.allow` in `.claude/settings.local.json`: the project's own non-destructive commands from `PREFS.commands`, in the space form with the `*` after the subcommand (`Bash(pnpm test *)`, `Bash(vendor/bin/pint --test *)`). Never a bare program (`Bash(npm *)`, `Bash(php *)`), and nothing that deploys, migrates, pushes or deletes.
- **Rule repairs.** Each existing rule agent 4 flagged for content above its frontmatter, with the one change: move that content to directly after the closing `---`. This is a correction of a silent loader failure, not a rewrite, so it applies under every `MODE`, `leave` included.
- **Hook.** `PREFS.hook`: `format` when agent 3 found a formatter that rewrites in place, `lint` when it found only a reporter, `format+lint` as one script when it found both, with each resolved executable path, the exact pipe-test command string `hook-wiring.md` step 4 will run, the script path and the target file (`.claude/settings.local.json` by default: the committed file runs the script on every teammate's machine and in every `-p` and CI session). Omit the bullet when no tool is installed on disk, and say so.
- **Language server.** Run Phase 5 step 1 now, against the installed marketplace manifests, never from memory: match Phase 1 agent 2's extension histogram against their `extensionToLanguage` maps. One plugin per extension with its marketplace; when two legitimate candidates exist for one language, name both, and Phase 5 asks which.
- **Skill candidates.** The procedures 2c set aside, listed only. This run writes no skill.

Then:

```
AskUserQuestion({
  header: "Proposal",
  question: "Does this setup look right? Nothing is written until you approve it.",
  options: [
    {label: "Proceed", description: "Write everything listed above, each file through the 3f existing-file gate."},
    {label: "Drop settings", description: "Instruction files and the language server; no permission rules and no hook."},
    {label: "Drop the hook", description: "Everything except the hook."},
    {label: "Instruction files only", description: "CLAUDE.md files and rules; no settings, no hook, no language server."}
  ]
})
```

No option carries `(Recommended)`: this is about how the user wants their project set up. The tool adds an "Other" answer on its own, which is where a moved target file or a dropped rule arrives; apply it to the queue and print the changed bullets before continuing. Record the approved set in `PREFS`; Phases 3 to 5 act on that set and nothing outside it. Under `--dry-run`, print the proposal and skip the question: nothing will be written either way.

## Phase 3: Draft and Write

### 3a. Invoke the writing skill (once, at phase entry)

Before drafting any file, invoke the writing skill exactly once:

```
Skill({skill: "ac:claude-md-rules-creator"})
```

The skill body becomes the playbook for the rest of this phase. Treat its pre-flight checklist at `SKILL.md:341-371` as the gate every emitted file must pass before the `Write` or `Edit` call.

### 3b. Draft the root `CLAUDE.md` (skip when `MODE=leave`)

Lead with the canonical preface from the skill body. The five-question frame (stack, where code lives, how to run things, conventions, off-limits) drives section selection, extended by the `## Golden Rules` and `## Testing` sections the template carries. Pull content from the Phase 1 deviations and the `PREFS` queue; never restate language defaults or anything the linter and formatter already enforce.

When Phase 1 found a root `AGENTS.md`, put `@AGENTS.md` on its own line after the preface and write below it only what is specific to Claude Code; restate nothing the import already carries. The import is what makes the file load on every session: Claude Code 2.1.277 reads `AGENTS.md` by itself only when no `CLAUDE.md` or `CLAUDE.local.md` exists, and not at all in a session that cannot fetch feature flags (telemetry disabled, Bedrock, Vertex), while an imported `AGENTS.md` is never read twice. The same reasoning covers `CLAUDE.local.md` in such a project: writing one would stop the direct read, so the import in the project file has to exist first.

When `MODE=improve`, do not draft a replacement. Produce one `Edit` per improvement against the existing file, each with a one-line reason, and show the set as a diff before applying it. The gate in 3f applies to the merged result.

Length budget: aim for 60 to 120 lines (the sweet spot the writing skill cites at `SKILL.md:350`, measured across eight production repositories). Hard ceiling 200 lines, which is also the official target ("target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence"). When the draft exceeds 120 lines, move topic content into `.claude/rules/<topic>.md` files rather than padding the root file.

Run the pre-flight checklist at `SKILL.md:341-371` against the draft and resolve every unchecked box before writing.

### 3c. Draft `CLAUDE.local.md` (skip when `--no-local`)

When `WRITE_LOCAL=false`, skip drafting; when a `CLAUDE.local.md` already exists, the 0d check still feeds the `.gitignore` bullet in 2d.

When `WRITE_LOCAL=true`, draft the personal companion. Content is per the writing skill's CLAUDE.local body recipe: the user's role, sandbox URLs, test accounts (pointers, never credentials), communication preferences. Honor the 1a worktree branch: for sibling or external worktrees, write the personal content to `~/.claude/<PROJECT_SLUG>-instructions.md` and make `CLAUDE.local.md` a stub whose first line is `@~/.claude/<PROJECT_SLUG>-instructions.md`.

When a root `AGENTS.md` exists and no project `CLAUDE.md` will exist after this run, the personal file is what switches Claude Code's direct `AGENTS.md` read off for this user, so it has to carry the import itself: put `@AGENTS.md` on its first line, and name that in the 2d Files bullet. For sibling worktrees the import goes into the `CLAUDE.local.md` stub as a second line, not into the home-directory file; this run writes `PATH_ARG`'s stub only, and 6d prints the two-line stub for the user to copy into each other worktree: a relative import resolves against the file that holds it, so each worktree then loads its own branch's `AGENTS.md`, and a path into the main checkout would be an external import that asks for approval.

Run the pre-flight checklist at `SKILL.md:341-371` before writing. Length budget: same 60 to 120 line sweet spot, 200 hard ceiling.

### 3d. Draft up to five `.claude/rules/*.md`

For each convention that took the rule branch in 2c, draft a focused rule file at `<PATH_ARG>/.claude/rules/<topic>.md` with `paths:` frontmatter per `SKILL.md:272-287`. Topic name follows the convention in the writing skill: lowercase, hyphen-separated, one focused subject.

Length budget per rule: 30 to 80 lines sweet spot, 200 hard ceiling. When a draft exceeds 80 lines, split the topic before writing.

Run the pre-flight checklist at `SKILL.md:341-371` against each rule draft. The path-scoped items at the bottom of the checklist matter most here: the glob actually matches your intent, and no `paths: ['**']`, which the loader treats as no `paths:` at all.

### 3e. Review the drafts (skip when `REVIEW=false` or `DRY_RUN=true`)

A drafted CLAUDE.md fails in ways its author cannot see from inside the draft: a command copied from a stale README, a glob that matches no file, a line the host prompt already carries. Create a fresh scratch directory with `mktemp -d "${TMPDIR:-/tmp}/ac-init-<PROJECT_SLUG>-XXXXXX"`, so an aborted earlier run's drafts are never reviewed again, put every draft from 3b to 3d under it mirroring its target path, write the merged Phase 1 findings beside them as `findings.md`, and spawn one reviewer:

```
Agent({
  subagent_type: "ac:oracle",
  description: "Review init-project drafts",
  prompt: "Review the Claude Code instruction drafts under <scratch dir> for the project at <PATH_ARG>, before they are written. findings.md holds the discovery evidence. The readers run <your own model ID>, which gets the <LEAN | CLASSIC> system prompt shape; judge duplication against that shape's section of the reference below and against the per-model bundle section for that model. Line budgets: CLAUDE.md and CLAUDE.local.md 60 to 120 lines with a 200 ceiling, each rule 30 to 80 with a 200 ceiling.\n\nClaims to test against the project itself, not against findings.md: every command in a draft runs as written (it is a manifest script, a Makefile or justfile target, or an installed binary); every path and every rule glob matches at least one tracked file (`git -C <PATH_ARG> ls-files`); no line restates what the linter, the formatter or the language already enforce; no line duplicates or contradicts ${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/claude-code-builtin-prompts.md for the model this project runs; nothing safety-critical sits only in a path-scoped rule; every rule file starts with `---` at byte 0, since anything above the frontmatter makes the rule load unconditionally; no secret, token or personal path appears in a team-shared file; each file is inside its line budget. Return your standard report, read-only."
})
```

Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` when it renders this command body, so the reference path above reaches the reviewer as an absolute path. Then fix every CONFIRMED finding in the scratch drafts, run the check a PLAUSIBLE finding names before acting on it, and keep the dismissed ones for the 6d report. The drafts 3f writes are the reviewed ones. Delete the scratch directory at the end of Phase 6.

### 3f. Existing-file safety and dry-run handling

When 2d approved the `.gitignore` line and `DRY_RUN=false`, append `CLAUDE.local.md` to `<PATH_ARG>/.gitignore` (create it if missing) before the first file below. Apply each approved rule repair as one `Edit` that moves the content above the frontmatter to directly after it; 2d already showed that exact change, so it skips the sidecar gate. Then, for every target file (`CLAUDE.md`, `CLAUDE.local.md`, each rule):

1. When `DRY_RUN=true`: print the intended write target path, the line count of the draft, and the first 20 lines of the draft. Do not call `Write` or `Edit`. After all targets have been printed, exit Phase 3 and continue to Phase 4; both Phase 4 and Phase 5 have their own dry-run branch that prints the plan and writes nothing, and Phase 6 then reports the run as a dry run.
2. When the target file does not exist: pass the pre-flight checklist, then call `Write`.
3. When the target file exists and `FORCE_OVERWRITE=true`: pass the pre-flight checklist, then call `Edit` (or `Write` for a full replacement when the existing content is being fully superseded).
4. When the target file exists and `FORCE_OVERWRITE=false`: write the draft to `<target>.proposed` (for example `CLAUDE.md.proposed`, `.claude/rules/api.md.proposed`). Then ask via `AskUserQuestion` (header "Apply?", question "`<target>` already exists. The proposed draft is at `<target>.proposed`. How should this file be handled?", options "Apply (overwrite original)", "Skip (leave original, keep `.proposed` for review)", "Edit (open the proposed file for manual edits, then re-run with `--force-overwrite`)"). Apply the user's choice. On "Apply", `Edit` or `Write` the original file with the proposed content and delete the sidecar. On "Skip", leave both files in place. On "Edit", leave the sidecar in place and print a one-line instruction to re-run the command with `--force-overwrite` after the manual edits.

## Phase 4: Settings: Permission Rules and the Hook

A CLAUDE.md line asking Claude to stay out of `.env` is a request, and so is one asking for a lint run; a permission rule and a hook are the things that hold. This phase writes only what the 2d proposal approved: the `permissions.deny` and `permissions.allow` rules, and one `PostToolUse` hook. Skip it when the approval dropped both, and say so.

### 4a. Targets

Each item goes to the file its 2d bullet named: deny rules to `<PATH_ARG>/.claude/settings.json`, allow rules and the hook to `<PATH_ARG>/.claude/settings.local.json`, unless the user moved one through "Other". The committed file applies to every teammate: a hook there runs on every machine and in every `-p` and CI session, and Claude Code applies a project file's `allow` rules only after the workspace trust dialog, so a moved item goes where the user said and nowhere else.

When a target does not exist, create it containing `{}`, and for `settings.local.json` add its name to `<PATH_ARG>/.gitignore` in the same step; Claude Code gitignores `settings.local.json` only when it saves a setting there itself. The `{}` is not cosmetic (`hook-wiring.md` seeds the file the same way before its merge): `jq` on a zero-byte file exits 0 and prints nothing, so a merge would `mv` an empty file into place and lose both the settings and the new keys without an error.

### 4b. Build the hook script (skip when the approval dropped the hook)

Follow the seven-step procedure, the script and the three proofs in `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/hook-wiring.md`, including its format-on-edit variant for `PREFS.hook.kind` `format` and its single-script rule for `format+lint`; do not re-derive them here. The 2d bullet printed the exact command the pipe-test runs, so its approval is that procedure's step 3 gate. When the registration target is `settings.local.json` and 2d approved it, append the script's path (`.claude/hooks/<script>.sh`) to `<PATH_ARG>/.gitignore` in the same step that writes the script. Take each executable name from the Phase 1 finding and bake it into the script as a literal; repository content never names the executable. State what the hook cannot do in the bullet and again in the report: it runs after the write lands, so it reports rather than blocks, and it does not fire when a `Bash` command rewrites the same file.

### 4c. Guard every settings write

For each target file, once, with all of its approved keys in one merge, stopping at the first failure:

1. `jq . <target>` when the file existed before this run. A non-zero exit means it was already malformed: stop, report the parse error and the path, and change nothing, not even a backup. Do not repair a malformation this command did not create. Say which way it fails: interactively Claude Code offers a fix dialog, while a `-p` or CI run skips the broken file or the broken values silently. Skip this step for a file 4a just created.
2. `cp` the target to `<target>.bak.$(date +%Y%m%d%H%M%S)` when it existed before this run.
3. Merge into `<target>.tmp`, then `mv` it into place. Never hand-write the whole file with `Write`. The hook entry uses the expression in `hook-wiring.md`; permission rules append without duplicating and keep every rule in its order, except that all `!` negations, existing and new, move to the end, because a negation only carves out of the rules listed before it:
   ```sh
   jq --argjson deny '["Read(.env)","Read(.env.*)","Read(!.env.example)"]' '
      def neg: test("^[A-Za-z]+\\(!");
      ((.permissions.deny // []) + $deny | reduce .[] as $r ([]; if index($r) then . else . + [$r] end)) as $all
      | .permissions.deny = [$all[] | select(neg | not)] + [$all[] | select(neg)]' \
      <target> > <target>.tmp && mv <target>.tmp <target>
   ```
   and the same shape with `allow` for `.permissions.allow`.
4. `jq -e` per key written: the hook selector from `hook-wiring.md` for the hook, and `jq -e --arg r '<rule>' '.permissions.deny | index($r)'` for each rule (the same with `allow`). Exit 0 is correct; exit 1 or 4 means the rule is missing, exit 5 means malformed JSON or wrong nesting.
5. `claude doctor` with the target project as the working directory. It reads the settings files without a trust prompt and names a rule it cannot parse.

Roll back when step 4 or step 5 fails, then report which step failed and what it printed. Rollback has two shapes: restore the backup when step 2 took one, and when 4a created the file this run, delete it and remove the `.gitignore` line instead. A rolled-back hook also takes its script and the script's `.gitignore` line with it. There is no backup to restore for a file that did not exist, and leaving a half-written one behind is worse than leaving none.

### 4d. Prove the rules and the hook

A written rule that does not match is as dead as a hook that never fires, and both look the same from the file. For the deny rules, the proof has to cross a fresh settings read, which this session may not have: say that the deny rules take effect from the next session, and list them. For the hook, run the three proofs `hook-wiring.md` names; the live-fire proof is the only one that exercises the wiring, and it needs this session to be running in `PATH_ARG`. When `PATH_ARG` is another directory, this session never loads that project's settings, so run the pipe-test and `jq -e` proofs, skip the live fire, and report it as not yet proved, to be checked from a session opened in that project, rather than as a settings-watcher problem.

Under `--dry-run`, print the script, each merge expression and each target path, then stop: create no file, add no `.gitignore` entry, and run none of the steps. The pipe-test and the live-fire proof both have side effects.

## Phase 5: Language Server

An LSP that answers turns `LSP findReferences` and `goToDefinition` into real tools for every later session in this project. Follow `${CLAUDE_PLUGIN_ROOT}/skills/claude-md-rules-creator/references/lsp-wiring.md`: enumerate the installed marketplace manifests at runtime rather than consulting any table, prefer a plugin from `claude-plugins-official` and say so explicitly when falling back to a third-party marketplace, and refuse a proposal whose candidates declare overlapping extensions instead of silently disabling one of them.

1. Match the extension histogram from Phase 1 agent 2 against the `extensionToLanguage` maps the reference enumerates.
2. The 2d proposal named at most one plugin per extension and the marketplace each comes from, and its approval covers them. When 2d named two legitimate candidates for one language, ask which through one `AskUserQuestion` now: that is a choice to hand to the user, not something to resolve silently.
3. On approval, merge `enabledPlugins["<plugin>@<marketplace>"] = true` into `~/.claude/settings.json` through the same five guarded steps as 4c, with one substitution: step 4's assertion is `jq -e '.enabledPlugins["<plugin>@<marketplace>"]' ~/.claude/settings.json`, not 4c's hook selector. Reusing 4c's `.hooks.PostToolUse` expression here exits 4 on a settings file that carries no hooks, and step 4's failure path would then roll back a write that succeeded. When the marketplace holding the plugin is not installed, do not install it: print the `/plugin marketplace add` and `/plugin install` lines for the user to run, and stop the phase there.
4. Verify both parts the reference requires, because neither is sufficient alone: the plugin appears under `enabledPlugins`, and one real `LSP` `hover` or `documentSymbol` call against an existing file of that language answers. Name the server that replied. When part 1 passes and part 2 fails, report it as the missing server binary it is, not as a misconfiguration, and name the binary.

When the detected language is outside every installed marketplace's coverage, name that gap and stop. Authoring a `.lsp.json` means authoring a plugin, which is not a project-setup step.

Under `--dry-run`, print the matched candidates and the marketplace each comes from, and write nothing.

## Phase 6: Read-Back, Dedupe, and Report

### 6a. Read every emitted file

`Read` each file actually written or proposed in Phase 3. A rule repair is not part of 6b or 6c and gets no second pass: 2d promised that one change and nothing else. For `--dry-run` runs there is nothing to read; skip to 6d and emit a summary stating that the run was a dry run.

### 6b. Parent-versus-child dedupe pass

Mirror the parent-versus-child dedupe rule from `init-deep` (linked under References), which holds that a child file never repeats its parent. For each line in a `.claude/rules/<topic>.md` file, check whether the same fact or near-paraphrase exists in the root `CLAUDE.md`. When a duplicate is found:

1. Keep the version in the more specific scope. A path-scoped rule for `src/api/**` keeps the rule; the root file drops it, unless `MODE=leave`, where CLAUDE.md is not touched: drop the line from the rule instead and say so in the report.
2. When the parent is more specific (the rule is a vague restatement), keep the parent and drop the child line.

Apply the dedupe pass by `Edit`ing the affected files. Run the pre-flight checklist again on any file the dedupe pass touched.

### 6c. Anti-pattern check

For every emitted file, scan against principles 8 and 9 at `SKILL.md:118-119`. Principle 8 forbids aggressive `CRITICAL` / `MUST` / `ALWAYS` repetition in the file body; the runtime already prepends `MEMORY_INSTRUCTION_PROMPT`. Principle 9 requires no duplication with the CC built-in system prompt or with another loaded layer.

When a violation is found, fix it in place with `Edit` and re-run the pre-flight checklist on the affected file.

### 6d. Report

One block per emitted file:

```
<absolute-path>
  lines: <count>
  sections: <comma-separated H2 headings>
  anti-pattern check: <pass | <one-line description of remaining issue>>
```

Then the placement table, one row per convention: the convention, its destination (root `CLAUDE.md` / hook / `.claude/rules/<topic>.md`), and which of the two 2c questions sent it there. Then one line each for the permission rules (each rule, its target file, and that deny rules apply from the next session and do not fence `grep -r` or a script, only the sandbox does), the hook (kind, tools, target file, whether the three proofs passed), the language server (plugin, marketplace, which server answered the probe), and the 3e review (findings fixed, findings dismissed with the reason, or "skipped" with the flag that skipped it).

End with a single line that states a check rather than announcing a step ("`/memory` in a new session in this project lists the new files", not "Next step: ..."), because the report is the end of the run and a closing next-step line reads as unfinished work. When proposed sidecars remain, the line names the files waiting in `.proposed` and that `--force-overwrite` applies them; otherwise it states the `/memory` check, and that `/doctor`'s CLAUDE.md trim check (2.1.206 and later) proposes cuts once the codebase moves on. Skill candidates from 2c go above that line, one each with the procedure it would carry, for `/ac:skill-creator`; this command writes no skill. When the live-fire hook proof failed while the pipe-test and `jq -e` passed, add the settings-watcher line from `hook-wiring.md` and point at `/hooks`.

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
- anthropics/claude-code#90449 (open: subdirectory CLAUDE.md and path-scoped rules load on the native `Read` tool only) and #82482 (closed as stale on 2026-09-22, not fixed: rules ignored while creating a new file). The 2.1.280 binary agrees: the only tool that adds a nested-memory trigger is Read, in its text, notebook and image branches. Both are why 2c never routes a safety-critical convention into a rule.
- `code.claude.com/docs/en/permissions` (the 2d rule shapes: gitignore matching at any depth for a bare filename, a `!` negation carving only out of the rules before it, deny evaluated before allow in every scope, a project file's `allow` applied only after workspace trust, a `Read` deny covering the file tools, recognised shell file commands and redirections but not `grep -r` or a subprocess, the space form with `*` after the subcommand) and the 2.1.257 changelog entry that makes `defaultMode` `auto` and `bypassPermissions` ignored in project and local files.
- A rule file's frontmatter has to start at byte 0 (`FRONTMATTER_REGEX = /^---\s*\n/` in the pinned `utils/frontmatterParser.ts:123`); verified live on 2.1.280 on 2026-09-23, where a comment above it made the rule load unconditionally.
- `code.claude.com/docs/en/memory#agents-md` (2.1.277 reads `AGENTS.md` only when no `CLAUDE.md` or `CLAUDE.local.md` exists, and not at all without feature-flag fetching, for example with telemetry disabled or on Bedrock; an `@AGENTS.md` import never loads it twice).
