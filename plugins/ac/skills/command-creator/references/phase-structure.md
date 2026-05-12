# Phase-Based Command Body Structure

Command bodies are usually multi-phase workflows: a context-gathering phase, an analysis or planning phase, an approval gate, an execution phase, and a verification or report phase. Read this when you are structuring a command body or when you need patterns for AskUserQuestion gates.

## Contents

- Why phase-based
- Standard phase template
- Phase building blocks
- AskUserQuestion patterns
- Approval gate placement
- Auto mode vs interactive mode
- Three worked phase structures
- Anti-patterns

## Why phase-based

Commands often orchestrate multi-step work. Without explicit phases, the model treats the body as one big to-do list and tends to:

- Skip ahead before context is gathered.
- Run side effects before the user is asked.
- Lose track of what's done and what's pending.

Numbered phases with explicit Goal + Actions + (when consequential) Success criterion give the model a checkpoint architecture. Each phase is a self-contained step; the model finishes one before starting the next.

This isn't required for trivial one-action commands (e.g., a context-grab-and-summarize). It pays off for any command with side effects, conditional logic, or more than two distinct steps.

## Standard phase template

```markdown
# <Command Title>

<One-line statement of what the command achieves for the user.>

## Identity

<Optional persona, when the command has a clear lens.>

## Capabilities and constraints

<Optional. What the command CAN do, CANNOT do, and MUST do. Useful for irreversible-side-effect commands.>

## Phase 1: Context

**Goal**: Read the state needed to proceed.
**Actions**:
1. Parse `$ARGUMENTS`. Detect any flags. Strip them from the working argument list.
2. Gather live state via shell injection (`\!`git status``, `\!`gh pr view``, etc.).
3. Read relevant project files (config, CLAUDE.md, plan files).

## Phase 2: Analyze

**Goal**: Decide what to do based on Phase 1.
**Actions**:
1. Synthesize findings.
2. Branch on conditions: if X, do A; if Y, do B.

## Phase 3: Approve (skip in auto mode)

**Goal**: Confirm with the user before side effects.

If `--interactive` detected in `$ARGUMENTS`, use AskUserQuestion with concrete options.
Auto mode (default): proceed with sensible defaults; do not prompt.

## Phase 4: Execute

**Goal**: Perform the action.
**Actions**:
1. <specific tool call, file edit, or bash command>
2. <next step>
**Success criterion**: <observable signal the step worked>

## Phase 5: Report

**Goal**: Tell the user what happened.

<One-line result, e.g., "Committed: <hash> <msg>, pushed to <remote>/<branch>".>

## Error Handling

- **<error case>**: <what to do>
- **<another case>**: <what to do>
```

Conventions:

- Each phase has **Goal** + **Actions**. Side-effect phases have **Success criterion**.
- Sub-numbered steps (3a, 3b) signal steps that can run in parallel.
- Always end with an **Error Handling** section listing the failure modes you can name.
- The "Report" phase commits to a specific output format so the user knows what to look for.

## Phase building blocks

Common building blocks that appear across many commands:

### Context phase

Gathers live state. Heavy use of shell injection.

```markdown
## Phase 1: Context

**Goal**: Read current state.

**Actions**:

1. Detect flags in `$ARGUMENTS`: `--interactive`, `--dry-run`. Strip and continue with the remaining args.
2. Run in parallel:

````markdown
```\!
git status
git diff --stat
git log --oneline -10
git branch --show-current
```
````

3. Read project conventions:
   - `CLAUDE.md` for repo-level guidance
   - `.commitlintrc*` or `commitlint.config.*` for commit message style
   - `package.json` for build/test commands

4. Store findings: `HAS_CHANGES`, `STAGED_ONLY`, `BRANCH`, `CONVENTION_STYLE`.
```

### Analyze phase

Decides on a course of action without acting yet.

```markdown
## Phase 2: Plan

**Goal**: Decide what to do.

**Actions**:

1. Based on Phase 1 findings, classify scope: small (single file), medium (1-3 modules), large (cross-cutting).
2. Pick the strategy:
   - Small: direct action, no prompt
   - Medium: prompt before destructive step
   - Large: present plan, require user approval

3. If `$ARGUMENTS` includes specific overrides (target branch, commit message), use those.
4. If anything is ambiguous, mark it for the approval phase.
```

### Approve phase

Last gate before side effects. Skipped in auto mode.

```markdown
## Phase 3: Approve

**Goal**: Confirm before side effects.

If `--interactive` was detected OR if any condition flagged in Phase 2 needs user input:

Call AskUserQuestion:

```json
{
  "questions": [{
    "question": "Review the plan above. Ready to execute?",
    "header": "Execute",
    "options": [
      {"label": "Yes", "description": "Run as planned."},
      {"label": "Adjust scope", "description": "I want to change what gets touched."},
      {"label": "Cancel", "description": "Stop here."}
    ]
  }]
}
```

On answer: "Yes" → Phase 4. "Adjust scope" → re-plan with user input. "Cancel" → stop.
```

### Execute phase

The actual work. Specific commands, file edits, tool calls.

```markdown
## Phase 4: Execute

**Goal**: Make the change.

**Actions**:

1. Run the change. Use the tools `allowed-tools` lists: `Bash(git add:*)`, `Bash(git commit:*)`, etc.
2. After each step, verify: `git status` shows clean, the file exists, the test passes.

**Success criterion**: <named observable, e.g., commit hash printed, file written, tests passing>.
```

### Report phase

Tell the user. The format matters; the user knows what to look for if you commit to a shape.

```markdown
## Phase 5: Report

**Goal**: Summary in one line.

Output format:

```
Committed: <hash> <subject>
Pushed to: <remote>/<branch>
```

If anything was unusual (skipped step, downgrade applied, partial success), add a second line noting it.
```

### Error handling

A named list of failure modes and what to do for each.

```markdown
## Error Handling

- **No changes**: report "Nothing to commit (clean tree)", stop.
- **Merge conflict state**: tell user conflicts need resolution first, stop.
- **Lint failure (auto mode)**: report failures, stop. User runs `--interactive` to override.
- **Protected branch**: warn but proceed. User has the lock.
- **Preflight command not found**: skip the check, note in output, continue.
```

## AskUserQuestion patterns

The `AskUserQuestion` tool surfaces an interactive prompt to the user. Three common shapes:

### Binary choice

```json
{
  "questions": [{
    "question": "Push the commits to origin?",
    "header": "Push",
    "options": [
      {"label": "Push", "description": "Push commits to origin/<branch>."},
      {"label": "Don't push", "description": "Keep commits local."}
    ]
  }]
}
```

### Multi-select (checkboxes)

```json
{
  "questions": [{
    "question": "Which verification layers should run?",
    "header": "Verification",
    "multiSelect": true,
    "options": [
      {"label": "Lint", "description": "Style and basic correctness", "selected": true},
      {"label": "Unit tests", "description": "Fast feedback on logic", "selected": true},
      {"label": "Integration tests", "description": "Slower, hits real services", "selected": false}
    ]
  }]
}
```

### Clearance checklist (loop until resolved)

For commands that need ambiguity resolved before proceeding, use a clearance checklist evaluated after each round:

```markdown
## Clearance checklist

After each user answer, re-evaluate:

- [ ] Core objective defined?
- [ ] Scope boundaries established?
- [ ] Technical approach decided?
- [ ] No blocking ambiguities remaining?

ALL checked → proceed. ANY unchecked → ask the next unclear dimension.
Include "Proceed with current understanding" as an escape option.
Max 3 rounds. If still ambiguous after 3, document assumptions and proceed.
```

## Approval gate placement

Place AskUserQuestion gates directly BEFORE the side-effect step they guard. Not at the top of the phase, not after the action. The pattern:

```markdown
## Phase 4: Execute

**Goal**: Apply the migration.

**Pre-check**: This will alter <N> rows in <table>. The change is irreversible.

If `--interactive` set OR auto mode disabled by safety policy:
- AskUserQuestion: "Run the migration?"
- On "No": stop with "Cancelled by user".
- On "Yes": continue.

**Actions**:
1. Run the migration script: ...
```

Anti-pattern: asking for approval AFTER the action ("Did that look right?") is too late if the action is irreversible.

## Auto mode vs interactive mode

A well-designed command serves both human-driven and automated contexts. Pattern:

- **Default behavior** is auto mode: no prompts, sensible defaults, run end-to-end.
- **`--interactive` flag** enables prompts at every decision point.
- The body branches on flag detection: if flag present, go through AskUserQuestion gates; if absent, take the default path.

Auto mode is safer than it sounds: irreversible actions still need protection (a separate `--force` flag for actions like force-push, or an `--allow-destructive` for migrations). Auto mode skips chatter, not safety.

Example from the prior MVP `/ac:commit`:

```markdown
## Default Behavior (Auto Mode)

By default, /ac:commit runs in auto mode, no interactive prompts:
- Stage all modified files relevant to the current task
- Run preflight checks (lint, tests), fail aborts the commit
- Detect convention, create atomic commit
- Push to remote

## Interactive Mode (--interactive)

Detect `--interactive` in `$ARGUMENTS`. If present:
- Strip the flag from arguments
- Use AskUserQuestion for all decisions
```

## Three worked phase structures

### Worked structure 1: Auto-mode action with safety gates

For commands like `/commit`, `/deploy`, `/publish` that should "just work" by default but have safety considerations.

Phases:
1. Context (parallel shell injection for state).
2. Plan (decide what to commit/deploy/publish).
3. Preflight checks (lint, tests, smoke). Fail aborts.
4. Execute (the actual side effect).
5. Verify (post-condition check).
6. Report (one-line summary).
7. Error handling.

`--interactive` opt-in for full control. `--skip-preflight` opt-in for orchestrators chaining commands.

### Worked structure 2: Interview-driven setup

For commands like `/init`, `/setup-coding`, `/setup-language` that gather user preferences before producing output.

Phases:
1. Detect what already exists (state read).
2. Round 1 of AskUserQuestion: high-level shape.
3. Round 2 of AskUserQuestion: details, dependent on Round 1 answers.
4. Round 3 of AskUserQuestion: edge cases, also dependent.
5. Synthesize answers + state into a plan.
6. Present plan, ask "Apply?" with options.
7. Apply (write files).
8. Confirm.

Use clearance checklists to bound the interview length. Max 3 rounds, then proceed with assumptions documented.

### Worked structure 3: Context-gathering report

For commands like `/pr-summary`, `/session-recap`, `/diagnose` that just gather and present.

Phases:
1. Context (heavy shell injection: PR diff, comments, checks).
2. Synthesize into a report following a specified format.
3. Print the report.

No side effects, no approval gates. Often `disable-model-invocation: false` so the model can fire it automatically when the user asks "what changed in this PR?".

## Anti-patterns

| Anti-pattern | Symptom | Fix |
|---|---|---|
| All actions in one phase | Model skips steps, hard to debug | Split into Phase 1 / 2 / 3 with explicit Goal per phase |
| Approval gate at top of phase | User approves before seeing the plan | Place gate directly before the side effect, after the plan is shown |
| No "Success criterion" on side-effect phases | Model proceeds without verifying the step worked | Add `**Success criterion**: <observable signal>` to every consequential action |
| No `Error Handling` section | Failure modes go unnamed; model improvises | Add a closing section with named failure cases |
| Auto mode prompts the user | Defeats automation | Keep auto-mode silent; opt prompts into `--interactive` |
| Interactive mode bypasses safety | "Yes I'm sure" prompts for irreversible ops | Even in interactive mode, irreversible actions go behind a SECOND confirmation or a separate `--force` flag |
| Mixing `[human]` action marker into auto-mode body | User isn't there to act in auto mode | Use `[human]` only for steps that genuinely require user action; restructure to do without if possible |
| Forgetting to strip flags from `$ARGUMENTS` | Flags leak into the actual work (e.g., `--interactive` ends up in a commit message) | After detecting flags in Phase 1, work from a flag-stripped variable |
