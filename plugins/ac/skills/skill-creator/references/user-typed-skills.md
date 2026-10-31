# User-Typed Skills (slash workflows)

A skill the user types as `/name [args]` to run a workflow: a commit, a deploy, a release, a context-grab report. Read this when the skill takes arguments, gathers live state with shell injection, runs in phases, or has side effects that need an approval gate. Everything in the parent SKILL.md still applies; this file covers what is specific to the typed form.

This file is read with the Read tool and is not preprocessed, so the literal `$ARGUMENTS`, `$0` and `` !`cmd` `` forms below are safe here. Inside a SKILL.md body they are live syntax: write them plainly when you mean them, and escape them (`&#36;ARGUMENTS`, `` \!`cmd` ``) when you only document them.

## Contents

- Commands are the older format
- Side effects: who may invoke
- Argument design
- Shell-injected context
- Phase structure
- Approval gates
- Pre-flight additions

## Commands are the older format

Custom commands were merged into skills in Claude Code 2.1.3. `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy`, run through the same loader, and accept the same frontmatter except `name` and `paths`. The docs call commands "the older format" and say "Prefer a skill for new work". What a command file lacks is the supporting-file directory: no `references/`, no `scripts/`, no `${CLAUDE_SKILL_DIR}`.

- **New work:** write `skills/<name>/SKILL.md`, in a project, user scope or plugin.
- **An existing command file:** it keeps working. When it grows a reference or a script, move it to `skills/<name>/SKILL.md`; the slash name stays the same. With both present, the skill wins.
- **Plugins:** both shapes namespace as `/<plugin>:<name>`. The only thing unique to commands is the plugin manifest `commands` field written as an object map with inline `content` (camelCase `argumentHint`, `allowedTools`), which replaces the default `commands/` directory scan. Reach for it only when a plugin generates its commands from the manifest.

## Side effects: who may invoke

A workflow that writes remotely, sends messages, deploys, or rewrites history sets `disable-model-invocation: true`. The model then never fires it on its own, its description leaves the model's listing (freeing budget), and it cannot be preloaded into a subagent through `skills:`.

The cost: nothing but a user typing `/name` reaches it. A plan step, another skill or a doc that says "run `/name`" is unexecutable for the model, which finds out only after trying. Write "ask the user to run `/name`" instead.

A read-only workflow (a status report, a context grab) keeps the default, so the model can run it when the request matches.

## Argument design

The argument shape is the contract with the user. Pick it before writing the body.

| Shape | Frontmatter | Body uses | Pick when |
|-------|-------------|-----------|-----------|
| Free-form | none | `$ARGUMENTS` | a sentence or query: `/deep-research how does auth work?` |
| Positional | `argument-hint: "[component] [from] [to]"` | `$0`, `$1`, or `$ARGUMENTS[N]` | a fixed tuple: `/migrate-component SearchBar React Vue` |
| Named | `arguments: [pr_number, target_branch]` | `$pr_number`, `$target_branch` | positions that read poorly as digits: `/cherry-pick 123 release` |

Parsing rules:

- `$ARGUMENTS` is the raw string as typed. `$N` and `$ARGUMENTS[N]` are the Nth shell-quoted token, 0-indexed: `/cmd "hello world" foo` gives `$0 = hello world`, `$1 = foo`. An out-of-range index substitutes an empty string.
- `$name` substitutes only when `name` is in `arguments:`. Names map by position, not by match. Digit-only names are dropped. The first 64 names of up to 64 characters are filled (2.1.301).
- `argument-hint` is autocomplete text only; it validates nothing and never reaches the model. A flag the model must pass belongs in `description`.
- With no placeholder in the body and arguments typed, the loader appends `ARGUMENTS: <input>` at the end. Treat that as a fallback; reference the input explicitly.
- All forms draw from one parsed list, so `$ARGUMENTS` and `$0` can coexist. Pick one style per position.

Flags (`--interactive`, `--dry-run`, `--skip-X`) have no parser. The body tells the model to detect them in `$ARGUMENTS`, strip them, and work from the remainder; after stripping it should not re-read `$ARGUMENTS`, or the flag returns. List the flags in a short section near the top so the user and the model see them.

When an input can be missing, say what happens: ask with AskUserQuestion, or stop and report the missing input. A body that assumes `$0` is set misbehaves silently on an empty substitution.

## Shell-injected context

Shell injection runs commands before the model reads anything and inlines their stdout, so the workflow starts from live state instead of guesses.

- Inline: `` !`git status` `` is replaced by the command's stdout. It needs whitespace or line start before the `!`, and the command cannot contain a backtick.
- Fenced: a block opened with three backticks and `!` runs as one script and is replaced by its output. Use it when commands share a working directory or variables.

Order at invocation: argument substitution, then `${CLAUDE_SKILL_DIR}` and the other tokens, then shell injection, then the rendered text enters the conversation as one message. So `` !`gh pr diff $pr_number` `` runs with the number already filled in.

```markdown
## Context

- Status: !`git status --short`
- Diff: !`git diff HEAD`
- Branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`
```

Rules that decide whether it runs:

- Each command goes through the normal permission check. `allowed-tools` pre-approves matching calls for the render, deny rules still win, and a refused command fails the whole render. List the exact patterns the injection uses (`Bash(git status:*)`), never bare `Bash`.
- `disableSkillShellExecution: true` in settings replaces each command with `[shell command execution disabled by policy]` for user, project, plugin and `--add-dir` skills; bundled and managed skills still run theirs. A skill that depends on injection should still read sensibly when it is off.
- Skills served over MCP never run injection.
- The preprocessor scans raw bytes and ignores markdown fences. A documentation example written with a live `!` runs on every invocation; escape it as `` \!`cmd` `` (and a backslash before the fenced form's backticks and bang). `shell: powershell` switches the shell; the default is bash.

Guard commands that can fail with a fallback in the command itself (`2>/dev/null || echo NO_UPSTREAM`) so the rendered context says what was missing instead of aborting.

## Phase structure

A workflow with side effects, branching, or more than two steps gets numbered phases. Each phase states a Goal and Actions, and a phase with consequences adds a Success criterion, so the model finishes one before starting the next and does not act before the context is in.

```markdown
# Release

Cut a release from main and publish the notes.

## Flags
`--dry-run` shows the plan and stops before Phase 4.

## Phase 1: Context
**Goal**: Read the state needed to decide.
**Actions**: parse flags from $ARGUMENTS; read the injected status, tags and log.

## Phase 2: Plan
**Goal**: Decide the version and the notes. Branch on what Phase 1 found.

## Phase 3: Approve
**Goal**: Confirm before anything leaves the machine (see Approval gates).

## Phase 4: Execute
**Actions**: tag, push, publish.
**Success criterion**: the tag exists on origin and the release page returns 200.

## Phase 5: Report
One line: `Released <version>: <url>`; a second line only for a skipped or partial step.

## Error handling
- Dirty tree: report it and stop.
- Tag exists: report the existing release and stop.
```

Conventions: sub-numbered steps (3a, 3b) mark steps that may run in parallel; the Report phase fixes the output shape so the user knows what to read; the error section lists failure modes you can actually name. A one-action context grab needs none of this.

## Approval gates

Put the AskUserQuestion call directly before the irreversible step it guards (a push, a send, a destructive git command, a data change), not at the top of the phase and never after the action. State what will happen in the question ("Push 3 commits to origin/main?") and give concrete options, each with a one-line description; offer multi-select only when several independent choices are made together.

A workflow used both by people and from pipelines defaults to one mode and switches with a flag: auto by default with `--interactive` to ask, or the reverse for anything destructive. Auto mode still runs its safety checks and stops on a failed one rather than approving silently.

A `context: fork` skill runs in a subagent, which has no AskUserQuestion, so a skill with gates stays inline. For ambiguity that needs several answers, ask in short rounds, re-check what is still unclear after each, offer "proceed with current understanding" as an option, and after three rounds write the assumptions down and continue.

## Pre-flight additions

On top of the parent checklist:

- Every `$ARGUMENTS`, `$N` and `$name` in the body matches the declared shape; a sample invocation, traced by hand, fills the right places.
- Each injected command is allowed by `allowed-tools` or the user's rules, and documentation examples carry the escaped `\!`.
- Every irreversible step has a gate before it, or an explicit safety check in auto mode.
- `disable-model-invocation: true` is set when the workflow has side effects, and nothing tells the model to run it.
- The Report phase names the output shape; the error section maps to real failures.
- A fresh-session run of `/name` with typical arguments renders the expected prompt.
