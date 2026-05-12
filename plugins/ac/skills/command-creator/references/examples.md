# Worked Command Examples

Five complete commands at different complexity tiers, ready to copy and adapt. Each is annotated to call out the choices.

## Contents

- Example 1: Context-grab-and-summarize (no side effects)
- Example 2: Action with safety preflight (flat .md)
- Example 3: Interview-driven setup (skill-directory)
- Example 4: Plugin command with bundled script
- Example 5: Cherry-pick with named args and approval gate

This file is a reference, not preprocessed. Examples below use literal `$ARGUMENTS`, `$0`, `$pr_number`, etc. and literal `!`<cmd>``. When you copy these into a new command body, the literals are exactly what you want.

---

## Example 1: Context-grab-and-summarize (no side effects)

**Goal**: Summarize uncommitted changes in the working tree, flag anything risky. Read-only.

**File**: `~/.claude/commands/changes.md` (user-level flat command)

```markdown
---
description: Summarizes uncommitted changes and flags anything risky. Use when the user asks what changed, wants a commit message, or asks to review their diff. Use even when the user does not say the word "summarize" but is asking about their working tree state.
---

## Current changes

!`git diff HEAD`

## Branch and recent commits

- Current branch: !`git branch --show-current`
- Last 5 commits: !`git log --oneline -5`

## Instructions

Summarize the changes above in two or three bullet points, then list any risks you notice such as:

- Missing error handling
- Hardcoded values that look like secrets or env-specific data
- Tests that may need updating
- Imports/exports that look orphaned

If the diff is empty, say "no uncommitted changes" and stop.
```

**Annotations**:

- **User-level scope** (`~/.claude/commands/`) so it's available across all projects.
- **Flat format**: no bundled files needed.
- **No `disable-model-invocation`**: model can fire it when the user asks "what changed?". Read-only, so no risk.
- **No arguments**: works on whatever the user's git tree currently is.
- **Heavy shell injection**: the diff and branch/log are all gathered before the model sees the prompt.
- **No approval gate**: read-only commands don't need one.

---

## Example 2: Action with safety preflight (flat .md)

**Goal**: Stage and commit changes with project-aware conventions. Push to remote in auto mode; allow `--interactive` override.

**File**: `<plugin>/commands/commit.md` (plugin-distributed)

```markdown
---
description: Stages and commits the current changes with project-aware commit conventions; pushes to remote in auto mode. Use when the user asks to "commit", "save these changes", or invokes `/my-plugin:commit`.
argument-hint: "[--interactive] [--skip-preflight]"
disable-model-invocation: true
allowed-tools: Bash(git add:*) Bash(git status:*) Bash(git commit:*) Bash(git push:*) Bash(git log:*) Bash(git diff:*) Bash(git branch:*) Bash(git rev-parse:*) Bash(npm run lint:*) Bash(npm test:*)
---

# Smart Commit

Request: $ARGUMENTS

## Phase 1: Context

**Goal**: Gather state and detect flags.

**Actions**:

1. Detect flags in `$ARGUMENTS`: `--interactive`, `--skip-preflight`. Strip detected flags; treat remaining args as commit-message hints.
2. Gather state:

```!
git status
git diff --stat
git diff --staged --stat
git log --oneline -10
git branch --show-current
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo NO_UPSTREAM
```

3. If nothing to commit (clean tree), report "Nothing to commit (clean tree)" and stop.

## Phase 2: Preflight

**Goal**: Ensure code quality before committing.

Skip this phase if `--skip-preflight` was detected.

**Actions**:

1. Detect tooling: `npm run lint` and `npm test` if `package.json` exists.
2. Run lint and tests in parallel.
3. If lint fails or tests fail in auto mode: report failures and stop. In interactive mode: AskUserQuestion to let the user decide.

## Phase 3: Plan

**Goal**: Decide what to commit and how to format the message.

**Actions**:

1. Look at recent commits (Phase 1 output) to detect convention style.
2. If `$ARGUMENTS` (after flag-stripping) is non-empty, use as commit-message hint.
3. Draft a concise commit message (1-2 sentences, focuses on "why").

## Phase 4: Execute

**Goal**: Stage, commit, push.

**Actions**:

1. Stage all relevant files. Exclude `.env`, credentials, anything that looks like a secret.
2. Create the commit using HEREDOC:

```
git commit -m "$(cat <<'EOF'
<commit message>
EOF
)"
```

3. Push to remote: `git push` (or `git push -u origin <branch>` if no upstream).

**Success criterion**: commit hash printed, push succeeded with no error.

## Phase 5: Report

Output:

```
Committed: <hash> <subject>
Pushed to: <remote>/<branch>
```

## Error Handling

- **Nothing to commit**: report "Nothing to commit (clean tree)", stop.
- **Merge conflict state**: tell user to resolve conflicts first, stop.
- **Lint or tests fail (auto mode)**: report failures, stop. User runs with `--interactive` to override.
- **Push fails**: report error, leave commits local. Tell user to push manually.
- **No upstream branch**: `git push -u origin <branch>` to set upstream on first push.
```

**Annotations**:

- **Plugin scope** (`<plugin>/commands/`): shipped via the plugin, auto-namespaced as `/<plugin>:commit`.
- **Flat format**: no bundled files needed for a single-file command.
- **`disable-model-invocation: true`**: commits have side effects; the user must trigger.
- **`allowed-tools` narrow patterns**: every git subcommand the body uses, listed explicitly. The user is not prompted mid-render.
- **Flag detection in Phase 1**: `--interactive` and `--skip-preflight` parsed from `$ARGUMENTS`, stripped before the message-hint logic.
- **Auto vs interactive**: default is silent auto mode; `--interactive` opens AskUserQuestion gates.
- **`--skip-preflight`**: opt-in flag for orchestrators that already verified (`/ac:execute` chains `/commit --skip-preflight` after its own verification).

---

## Example 3: Interview-driven setup (skill-directory)

**Goal**: Generate a project-specific `CLAUDE.md` from a multi-round interview. Needs reference templates bundled alongside.

**File**: `~/.claude/skills/init-claude-md/SKILL.md` (skill-directory format, with templates bundled in `references/`)

```markdown
---
description: Generates or enhances a project CLAUDE.md from a structured interview. Use when the user wants to set up CLAUDE.md, run `/init`, or asks to capture team conventions in a file Claude loads at session start.
disable-model-invocation: true
argument-hint: "[--refresh]"
allowed-tools: Read Write Edit Glob Grep AskUserQuestion
---

# Init CLAUDE.md

Request: $ARGUMENTS

## Phase 0: Detect existing CLAUDE.md

Read `./CLAUDE.md`. Branch:
- File exists, no `--refresh` flag: ask via AskUserQuestion whether to enhance or replace.
- File exists, `--refresh` set: skip the question, treat as enhance.
- File missing: proceed to fresh setup.

## Phase 1: Codebase survey

Read project manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), README, CI config, existing `.claude/rules/`.

Detect:
- Build, test, lint commands
- Languages and frameworks
- Code style rules differing from defaults
- Non-obvious gotchas (required env vars, special test commands)

## Phase 2: Interview round 1 (shape)

AskUserQuestion: which CLAUDE.md files to set up?
Options: "Project CLAUDE.md" / "Personal CLAUDE.local.md" / "Both"

AskUserQuestion: should we also set up skills or hooks?
Options: "Skills + hooks" / "Skills only" / "Hooks only" / "Neither"

## Phase 3: Interview round 2 (gaps from Phase 1)

For each gap Phase 1 could not figure out from code alone, ask one AskUserQuestion. Bound to 3 rounds maximum.

## Phase 4: Synthesize and present

Build a proposal:
- CLAUDE.md content (using `${CLAUDE_SKILL_DIR}/references/project-claude-md-template.md` as the base)
- Skills to create (each as a one-line item)
- Hooks to add (each as a one-line item)

Present the proposal. AskUserQuestion: "Does this look right? Apply?"
Options: "Apply" / "Adjust" / "Cancel"

## Phase 5: Apply

Write the files. For CLAUDE.md, read the template at `${CLAUDE_SKILL_DIR}/references/project-claude-md-template.md` and substitute the user's answers into it.

## Phase 6: Confirm

Report what was written. Suggest running `/reload-plugins` if any plugin files were added.

## Error Handling

- **CLAUDE.md exists, user picks "Cancel"**: stop, leave existing file alone.
- **User answers all rounds with "Other"**: ask the next dimension. Max 3 total rounds; after that proceed with assumptions documented in CLAUDE.md.
- **File write fails (permission)**: report error, stop.
```

**Bundled at**:

- `~/.claude/skills/init-claude-md/references/project-claude-md-template.md`
- `~/.claude/skills/init-claude-md/references/personal-claude-md-template.md`

**Annotations**:

- **Skill-directory format** because templates need to live alongside the command and be referenced via `${CLAUDE_SKILL_DIR}/references/...`.
- **`disable-model-invocation: true`**: the user explicitly invokes; the model deciding to overwrite CLAUDE.md is the wrong default.
- **`AskUserQuestion` in `allowed-tools`**: even though AskUserQuestion is typically pre-approved, listing it documents that the body uses it.
- **Multi-round interview**: each round has a clear purpose; later rounds depend on earlier answers.
- **Bounded interview**: max 3 rounds, then proceed with assumptions. Prevents infinite loops.

---

## Example 4: Plugin command with bundled script

**Goal**: Generate a CHANGELOG.md entry by running a script that parses merged PRs.

**File**: `<plugin>/skills/changelog/SKILL.md` (skill-directory format, with a Python script bundled)

```markdown
---
description: Generates a CHANGELOG.md entry for the upcoming release. Parses merged PRs by Conventional Commit type and writes the section. Use when the user asks to update the changelog, draft release notes, or is preparing a release.
disable-model-invocation: true
argument-hint: "[next-version-tag]"
arguments: [next_version]
allowed-tools: Bash(gh pr list:*) Bash(python:*) Read Edit
---

# Generate CHANGELOG entry for $next_version

## Phase 1: Validate input

If `$next_version` is empty, AskUserQuestion: "What's the next version tag?"

## Phase 2: Run the script

!`python ${CLAUDE_SKILL_DIR}/scripts/build_changelog.py "$next_version"`

The script:
- Finds the most recent semver tag.
- Lists every merged PR since via `gh pr list`.
- Groups by Conventional Commit type derived from PR title prefix.
- Writes the entry to `${CLAUDE_SKILL_DIR}/scratch/$next_version.md`.

## Phase 3: Review

Read `${CLAUDE_SKILL_DIR}/scratch/$next_version.md`. Sanity-check:

- Every PR is grouped under the right type.
- PRs without a `feat/fix/chore/...` prefix go under "Other"; flag those.
- Breaking changes (title ends with `!:` or has the `breaking` label) appear at the top.
- Dates and PR numbers are correct.

## Phase 4: Insert into CHANGELOG.md

Read `CHANGELOG.md` to see the existing format. Add the new section immediately after the `# Changelog` header. Preserve format: match heading depth, blank lines, link style.

## Phase 5: Verify

Re-read `CHANGELOG.md` and confirm:
- The new section is present in the right position.
- Format matches surrounding sections.
- No PRs from before the previous tag leaked in.

Report: "Added $next_version section to CHANGELOG.md. Review with `git diff CHANGELOG.md` and commit."

## Error Handling

- **No previous tag**: assume this is the first release. Use Phase 2's script with the `--first-release` flag.
- **`gh pr list` fails**: report error, suggest user runs `gh auth login`.
- **Script exits non-zero**: read its stderr, report specific failure.
```

**Bundled at**: `<plugin>/skills/changelog/scripts/build_changelog.py` (Python script that does the gh-CLI walk and grouping).

**Annotations**:

- **Skill-directory format** is the right call here: a script needs to live alongside the command.
- **`${CLAUDE_SKILL_DIR}/scripts/build_changelog.py`** resolves to the script's absolute path; portable across installs.
- **Shell injection executes the script** as preprocessing. The model gets the output, not the script.
- **Named arg `$next_version`** instead of `$0`. Reads better in the body.
- **Verify phase**: the model reviews the output of the script before inserting; the script doesn't have to be perfect.

---

## Example 5: Cherry-pick with named args and approval gate

**Goal**: Cherry-pick a merged PR to the release branch and open a backport PR. Has hard-to-reverse side effects on a sensitive branch.

**File**: `.claude/commands/cherry-pick.md` (project-level flat command)

```markdown
---
description: Cherry-picks a merged PR to the current release branch and opens a backport PR. Use when the user says "cherry-pick to release", "CP this PR", "backport this", or asks to ship a fix to the release branch.
disable-model-invocation: true
argument-hint: "[pr-number]"
arguments: [pr_number]
allowed-tools: Bash(gh pr view:*) Bash(gh pr create:*) Bash(git fetch:*) Bash(git checkout:*) Bash(git pull:*) Bash(git cherry-pick:*) Bash(git push:*) Bash(git status:*) Bash(git branch:*) AskUserQuestion
---

# Cherry-pick PR $pr_number to release

## Phase 1: Validate

If `$pr_number` is empty, AskUserQuestion: "Which PR number to cherry-pick?"

Verify PR is merged:

!`gh pr view $pr_number --json mergeCommit -q .mergeCommit.oid`

If output is empty: PR is not merged. Report "PR #$pr_number is not merged; cannot cherry-pick" and stop.

## Phase 2: Fetch release

Run:

```!
git fetch origin release
git checkout release
git pull --ff-only
```

If `git pull --ff-only` fails: report the conflict and stop.

## Phase 3: Create backport branch

!`git checkout -b cp/$pr_number`

If branch already exists: report "Branch cp/$pr_number already exists; cherry-pick previously attempted. Choose a different PR or delete the existing branch." Stop.

## Phase 4: Cherry-pick

!`git cherry-pick <merge-sha>` (where merge-sha is the output of Phase 1).

If conflicts: stop and AskUserQuestion: "Conflict during cherry-pick. How to resolve?"
Options: "Let me resolve manually" / "Abort the cherry-pick"

Do NOT auto-resolve conflicts on a release branch. The user has the lock.

## Phase 5: Push and open PR

```!
git push -u origin cp/$pr_number
gh pr create --base release --title "Cherry-pick #$pr_number" --body "Backports #$pr_number to release."
```

Report: "Backport PR created: <URL>"

## Error Handling

- **PR not merged**: see Phase 1.
- **Release branch pull conflict**: see Phase 2.
- **Branch already exists**: see Phase 3.
- **Cherry-pick conflict**: see Phase 4. The user decides.
- **Push fails (permission)**: report error, leave commit local.
- **`gh pr create` fails**: report error, the cherry-pick commit is still on the branch and can be pushed/PR'd manually.
```

**Annotations**:

- **Named arg `$pr_number`**: reads cleanly throughout the body.
- **`disable-model-invocation: true`**: cherry-pick to a release branch is a sensitive operation; user must trigger.
- **`allowed-tools` narrow**: every git subcommand and gh subcommand listed individually.
- **Phase 4 is the irreversible step**: conflict handling explicitly hands off to the user. The body says "Do NOT auto-resolve conflicts on a release branch" because the cost of getting it wrong is high.
- **Each phase has its own error handling reference** in the Error Handling section. The body is small enough that the reader can scan it.
- **No auto-mode chatter**: this command is always interactive (every phase has a potential approval gate). No `--interactive` flag because that's the only mode it has.
