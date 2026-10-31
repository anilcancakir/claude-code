# Rebase mode

Rewriting or moving commits: squash, autosquash, reorder, split, rebase onto the base branch, cherry-pick. `NO_PUSH` from Phase 0 of `SKILL.md` holds here.

## 1. Safety

Gather in one parallel batch:

```bash
git branch --show-current
git log --oneline -20
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"
git status --porcelain
git stash list
```

| Condition | Action |
|---|---|
| On `main` or `master` | Abort any rebase or rewrite. A cherry-pick only adds a commit and is allowed. |
| Dirty working tree | `git stash push -m "pre-rebase"` first |
| Commits already pushed | The rewrite needs a force push; see Push below |
| All commits local | Proceed |
| Upstream diverged | May need `--onto` |

| Request | Strategy |
|---|---|
| squash, clean up | squash |
| rebase on main, update the branch | rebase onto base |
| autosquash, apply fixups | autosquash |
| reorder | `git rebase -i`, move the lines |
| split a commit | `git rebase -i`, mark `edit`, then `git reset HEAD^` and recommit in units |
| take one commit from elsewhere | `git cherry-pick <hash>`; resolve conflicts as below |

## 2. Execute

```bash
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)

# squash everything since the base into one commit
git reset --soft $MERGE_BASE
git commit -m "<summary of all changes>"

# apply fixup! commits
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash $MERGE_BASE

# update the branch from its base
git fetch origin
git rebase origin/main
```

A messy, fully local history can be rebuilt: `git reset --soft $MERGE_BASE`, then recommit in atomic units by Phase 3 and 4 of `SKILL.md`.

Conflicts:

1. `git status` lists the "both modified" files.
2. Read each one, understand both sides, edit out the markers (`<<<<`, `====`, `>>>>`).
3. `git add <file>`, then `git rebase --continue` (or `git cherry-pick --continue`).
4. Stuck: `git rebase --abort` returns to the start.

Recovery: `git reflog` then `git reset --hard <hash>` for the original commits; `git fsck --lost-found` for lost ones.

## 3. Verify and push

```bash
git status
git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)..HEAD
git diff ORIG_HEAD..HEAD --stat
```

Restore anything stashed in step 1 with `git stash pop`.

Push only when the request named it and `NO_PUSH` is unset. A branch never pushed takes `git push -u origin <branch>`. A rewrite of pushed history needs `git push --force-with-lease origin <branch>`, which is its own outward action: ask first with `AskUserQuestion` (`Push with --force-with-lease` / `Skip push`) unless the request already named the force push. Plain `--force` is never used.

Report: strategy, commits before and after, conflicts resolved, the new history, and the push instruction when it was skipped.
