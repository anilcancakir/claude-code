---
description: Commit current changes as atomic commits via the `ac:git-master` skill. Detects the repo's commit style from the last 30 commits, splits multi-file changes into multiple commits (3+ files require 2+ commits, 5+ require 3+, 10+ require 5+), keeps test files paired with their implementation, and pushes when an upstream exists. Runs an optional preflight (typecheck + test + lint) before committing. Accepts `--skip-preflight` (invoked by `/ac:execute` Phase 4 since execution already verified) and `--no-push` (commit locally only).
argument-hint: [--skip-preflight] [--no-push]
allowed-tools: Bash, Skill, Read
effort: medium
---

# /ac:commit

Commit the current working-tree changes as atomic commits using the `ac:git-master` skill.

Request: $ARGUMENTS

## Phase 0: Parse arguments

1. Scan `$ARGUMENTS` for `--skip-preflight` → `SKIP_PREFLIGHT = true | false`.
2. Scan `$ARGUMENTS` for `--no-push` → `NO_PUSH = true | false`.
3. Treat any other tokens as free-form note; ignore for now (the commit-style detection in Phase 2 produces the actual message).

## Phase 1: Context

Capture the current git state up front so the rest of the command works from real data, not assumptions.

- Current branch: !`git branch --show-current`
- Working-tree status: !`git status --short`
- Staged diff stat: !`git diff --staged --stat`
- Unstaged diff stat: !`git diff --stat`
- Recent commits (30 for style detection): !`git log -30 --pretty=format:"%h %s"`
- Upstream tracking: !`git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"`
- Merge base with main/master: !`git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo "NO_BASE"`
- Local-only commits ahead of base: !`git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)..HEAD 2>/dev/null || echo "NO_BASE"`

If the working tree is clean (status output empty), stop with the message `Nothing to commit. Working tree clean.` and skip every remaining phase.

## Phase 2: Preflight (skip if `SKIP_PREFLIGHT`)

**Goal**: Catch obvious breakage before writing history.

Skip this phase when `SKIP_PREFLIGHT = true`. `/ac:execute` Phase 4 sets this flag because it already ran the Final Verification Wave; running typecheck and tests a second time wastes time.

When `SKIP_PREFLIGHT = false`:

1. Read `CLAUDE.md` and `CLAUDE.local.md` if present to find typecheck, test, and lint commands (sections labelled `commands`, `scripts`, or under a "Build / Test / Lint" header). Fall back to `package.json` `scripts` block when CLAUDE.md does not name the commands.
2. Run typecheck, then tests, then linter in that order. Each one through `Bash`. Use the project's actual commands, not generic guesses.
3. **Pass**: continue to Phase 3.
4. **Fail**: stop. Print which preflight step failed and the first ~30 lines of the failure output. Do not commit. The user fixes the issue and re-invokes `/ac:commit`.

If no preflight commands are discoverable, log `Preflight: no commands found in CLAUDE.md or package.json; skipping.` and continue. Do not block on missing config.

## Phase 3: Delegate to `ac:git-master` (COMMIT MODE)

**Goal**: Produce atomic commits in the repo's detected style.

1. Invoke the `ac:git-master` skill via the Skill tool. The skill's body carries the full COMMIT MODE workflow (Phase 0 parallel context, Phase 1 style detection with blocking output, Phase 2 branch safety, Phase 3 atomic-unit planning with blocking output, Phase 4 strategy and execution, Phase 5 verification).
2. Honor every blocking output the skill prints: the STYLE DETECTION block and the COMMIT PLAN block both have to render in the chat before any `git commit` runs.
3. Honor the skill's split discipline. Apply the file-count rule to every change set, not only the first: 3+ files require 2+ commits, 5+ files require 3+ commits, 10+ files require 5+ commits. A single commit spanning multiple unrelated directories is a planning bug; resplit before executing.
4. Keep test files paired with their implementation in the same commit. The skill enumerates the test-path patterns.
5. Stay on the current branch. Never rebase or rewrite published history without a separate explicit user request.

The skill returns control after every planned commit has been created (verified via `git log --oneline <merge-base>..HEAD`).

## Phase 4: Push (skip if `NO_PUSH` or no upstream)

**Goal**: Publish the new commits.

Skip this phase when `NO_PUSH = true` or the Phase 1 upstream check printed `NO_UPSTREAM`.

1. **Branch guard**: if the current branch is `main` or `master`, print a warning and ask before pushing.
   ```
   AskUserQuestion({
     header: "Push main?",
     question: "Current branch is `<branch>`. Push directly?",
     options: [
       {label: "Push", description: "Push to <upstream>."},
       {label: "Skip push", description: "Leave commits local; user pushes manually."}
     ]
   })
   ```
   On "Skip push", jump to Phase 5 with a note that the push was skipped.
2. **Push strategy** (from the skill's Phase 5):
   - New commits only, no rewritten history → `git push`.
   - Fixup commits applied or rebase happened → `git push --force-with-lease`. Plain `--force` is never used.
3. Capture the push output (success line + remote ref). On failure, print the error and stop; the user resolves and re-invokes.

## Phase 5: Report

Render one block at the end so the user sees the outcome at a glance:

```
## Commit Complete

Branch: <name> [<upstream> | local-only]
Style: <SEMANTIC | PLAIN | SENTENCE | SHORT>
Commits created: <N>
  <hash> <message>
  <hash> <message>
Push: <pushed to <remote>/<branch> | skipped (no upstream) | skipped (--no-push) | skipped (user declined)>
Preflight: <PASS | SKIPPED | NOT CONFIGURED>
```

When `/ac:commit` was invoked from `/ac:execute` Phase 4, the report block is the handoff signal that the execution pipeline is done.

## Error Handling

- **Nothing to commit**: Phase 1 detected a clean tree. Print the clean-tree line and exit; do not run preflight, the skill, or push.
- **Preflight failure**: print the failing step and first ~30 lines of output. Do not stage anything, do not invoke the skill, do not push. The user fixes and re-invokes.
- **Skill split refused**: the skill prints a `COMMIT PLAN` with `K < min_commits`. Tell the user the split is too coarse, show the planned-vs-required counts, and re-run the planning step (the skill's own validation should catch this; this is a backstop).
- **Merge conflicts mid-rebase**: the skill is in COMMIT MODE, not REBASE MODE; conflicts here mean a fixup or `--autosquash` raced with concurrent edits. Stop, print `git status`, surface the conflict to the user, and abort the operation (`git rebase --abort` if a rebase is in progress).
- **Push rejected (non-fast-forward)**: the remote has commits the local branch does not. Stop. Do not force-push without an explicit user request. Print the remote's view (`git log <upstream>..HEAD` and `git log HEAD..<upstream>`) and let the user decide.
- **Force-push needed on protected branch**: refuse and ask. Force-pushing `main`/`master` requires an explicit user "yes" via `AskUserQuestion`; plain `--force` stays off the table regardless.

## Reminders

- The `ac:git-master` skill drives the actual commit planning and message writing. Phase 3 of this command is the entry point; do not duplicate its style-detection or splitting logic in the command body.
- Apply the split rule to every change set, not only the first. One commit from 3+ unrelated files is a planning bug.
- Use `--force-with-lease` when rewriting history. Plain `--force` is not used by this command.
- `/ac:execute` always invokes with `--skip-preflight` because the Final Verification Wave (F1-F4) and Phase 3 review already covered the verification ground.
