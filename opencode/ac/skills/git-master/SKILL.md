---
name: git-master
description: "Make atomic commits in the repo's own style, rebase or squash, and trace history with blame, bisect and pickaxe. Use when rebasing, squashing, cherry-picking or tracing history, or for one hand-picked commit; the commit skill splits, preflights and pushes the working tree."
---
<!-- ported-from: plugins/ac/skills/git-master/SKILL.md sha256:6244075f318f4396a4e8c9dbc8973c6bd7a6151789a368fdc35e92652d9d9212 -->

# Git Master

You are a Git expert combining three specializations:

1. **Commit Architect**: Atomic commits, dependency ordering, style detection
2. **Rebase Surgeon**: History rewriting, conflict resolution, branch cleanup
3. **History Archaeologist**: Finding when/where/who introduced specific changes

---

## MODE DETECTION (FIRST STEP)

Analyze the user's request to determine operation mode:

| User Request Pattern | Mode | Jump To |
|---------------------|------|---------|
| "commit", changes to commit, stage and commit | `COMMIT` | Phase 0-6 |
| "rebase", "squash", "cleanup history", "fixup" | `REBASE` | Phase R1-R4 |
| "find when", "who changed", "git blame", "bisect", "who wrote" | `HISTORY` | Phase H1-H3 |

Parse the actual request. Do not default to COMMIT mode.

---

## CORE PRINCIPLE: ONE COMMIT PER ATOMIC UNIT

An atomic unit is what can be reviewed and reverted alone: a function with its test, a migration with the model change that needs it. Make one commit per unit. File count is a hint, not the rule: a rename across callers is one unit in many files, and two files can be two units. A commit that holds two units is a planning bug, so split it before executing.

**Signals that a change set holds more than one unit:**

| Signal | Reading |
|--------|---------|
| Different directories/modules | Likely separate units |
| Different component types (model/service/view) | Likely separate units |
| Can be reverted independently | Separate units |
| Different concerns (UI/logic/config/test) | Likely separate units |
| New file vs modification | Separate units unless one needs the other |

**Keep files in one commit when** splitting would leave a commit that does not build or cannot be reverted alone (a function and its test, a migration and the model change that needs it).

---

## COMMIT MODE (Phase 0-6)

### Phase 0: Parallel Context Gathering

Execute ALL commands in parallel:

```bash
# Group 1: Current state
git status
git diff --staged --stat
git diff --stat

# Group 2: History context
git log -30 --oneline
git log -30 --pretty=format:"%s"

# Group 3: Branch context
git branch --show-current
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"
git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)..HEAD 2>/dev/null
```

Capture:

1. Changed files (staged vs unstaged)
2. Recent 30 commit messages for style detection
3. Branch position relative to main/master
4. Upstream tracking status
5. Local-only commits (PR scope)

### Phase 1: Style Detection (BLOCKING OUTPUT)

Output the detection result before proceeding.

**Commit style classification:**

| Style | Pattern | Example | Detection |
|-------|---------|---------|-----------|
| `SEMANTIC` | `type: msg` or `type(scope): msg` | `feat: add login` | Matches `^(feat\|fix\|chore\|refactor\|docs\|test\|ci\|style\|perf\|build)(\(.+\))?:` |
| `PLAIN` | Description, no prefix | `Add login feature` | No conventional prefix, >3 words |
| `SENTENCE` | Full sentence | `Implemented the new login flow` | Complete grammatical sentence |
| `SHORT` | Minimal keywords | `format`, `lint` | 1-3 words only |

**Detection algorithm:**

```
From last 30 commits:
  semantic_count >= 15 (50%) → SEMANTIC
  plain_count   >= 15 (50%) → PLAIN
  short_count   >= 10 (33%) → SHORT
  else                      → PLAIN (safe default)
```

**Mandatory output:**

```
STYLE DETECTION
===============
Analyzed: 30 commits

Style: [SEMANTIC | PLAIN | SENTENCE | SHORT]
  - Semantic (feat:, fix:): N (X%)
  - Plain: M (Y%)
  - Short: K (Z%)

Reference examples:
  1. "actual commit message from log"
  2. "actual commit message from log"
  3. "actual commit message from log"

All commits will follow: [STYLE]
```

### Phase 2: Branch Context Analysis

**Determine rewrite safety:**

```
IF current_branch == main OR master:
  → NEW_COMMITS_ONLY - never rewrite

ELSE IF all commits local (not pushed):
  → AGGRESSIVE_REWRITE - fixup, reset, rebase freely

ELSE IF pushed but not merged:
  → CAREFUL_REWRITE - fixup OK, warn about force push
```

### Phase 3: Atomic Unit Planning (BLOCKING OUTPUT)

**Split by directory/module first, then by concern, then check that each group is one atomic unit.**

**Test pairing rule:** Test files go in the same commit as their implementation.

```
Test patterns to match:
  test_*.py ↔ *.py       *.test.ts ↔ *.ts
  *_test.py ↔ *.py       *.spec.ts ↔ *.ts
  __tests__/*.ts ↔ *.ts  tests/*.py ↔ src/*.py
```

**Output:**

```
COMMIT PLAN
===========
Files changed: N
Planned commits: K

COMMIT 1: [message in detected style]
  - path/to/file1.py
  - path/to/file1_test.py
  Together because: implementation + its test

COMMIT 2: [message in detected style]
  - path/to/file2.py

Execution order: Commit 1 → Commit 2 → ...
(follows dependency: Level 0 → Level 1 → Level 2 → ...)
```

**Dependency ordering:**

```
Level 0: Utilities, constants, type definitions
Level 1: Models, schemas, interfaces
Level 2: Services, business logic
Level 3: API endpoints, controllers
Level 4: Configuration, infrastructure
```

**Validation before execution:**

- Each commit is one atomic unit: reviewable and revertable alone
- A commit with more than one file carries a "Together because" line naming the unit
- Each message matches detected style
- Test files paired with implementation
- Files from different directories share a commit only when they form one unit

If any check fails, replan.

### Phase 4: Strategy & Execution

**Decide for each group:** FIXUP (complements existing commit, target hash exists) or NEW COMMIT (independent unit, no target).

**History rebuild:** If all commits are local and history is messy - `git reset --soft $(git merge-base HEAD main)` then re-commit in proper atomic units.

**Execute each group in dependency order:**

```bash
git add <file1> <file2>
git diff --staged --stat
git commit -m "<message-matching-detected-style>"
```

Commit with the git identity exactly as `git config` has it: no `-c user.name`, `-c user.email` or `--author` override, and no `Co-Authored-By` or `Signed-off-by` trailer naming the operator.

**For fixup commits:**

```bash
git add <files>
git commit --fixup=<target-hash>

# After all fixups - single autosquash
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash $MERGE_BASE
```

**Message style:**

| Style | Example |
|-------|---------|
| SEMANTIC | `feat: add login feature` |
| PLAIN | `Add login feature` |
| SHORT | `format` / `lint` |
| SENTENCE | `Implemented the new login flow` |

### Phase 5: Verification

```bash
git status
git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)..HEAD
```

**Push only when the caller asked.** Without a request, leave the commits local and say so in the report. When asked: new commits only → `git push`. A rewritten history (fixups autosquashed, a reset rebuild of pushed commits) needs `--force-with-lease` and its own explicit request; plain `--force` is never used.

Report: strategy used, commits created, history listing, next steps.

---

## REBASE MODE (Phase R1-R4)

### Phase R1: Context & Safety

Execute in parallel:

```bash
git branch --show-current
git log --oneline -20
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master
git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "NO_UPSTREAM"
git status --porcelain
git stash list
```

**Safety assessment:**

| Condition | Risk | Action |
|-----------|------|--------|
| On main/master | CRITICAL | **ABORT** - never rebase main |
| Dirty working directory | WARNING | Stash first: `git stash push -m "pre-rebase"` |
| Pushed commits exist | WARNING | Requires force-push; confirm with user |
| All commits local | SAFE | Proceed freely |
| Upstream diverged | WARNING | May need `--onto` strategy |

**Strategy routing:**

| Request | Strategy |
|---------|----------|
| "squash commits", "cleanup" | INTERACTIVE_SQUASH |
| "rebase on main", "update branch" | REBASE_ONTO_BASE |
| "autosquash", "apply fixups" | AUTOSQUASH |
| "reorder commits" | INTERACTIVE_REORDER |
| "split commit" | INTERACTIVE_EDIT |

### Phase R2: Execution

**Squash (combine all into one):**

```bash
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)
git reset --soft $MERGE_BASE
git commit -m "Combined: <summarize all changes>"
```

**Autosquash (merge fixup! commits):**

```bash
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash $MERGE_BASE
```

**Rebase onto (update branch from base):**

```bash
git fetch origin
git rebase origin/main
```

**Conflict resolution workflow:**

1. Identify: `git status` - find "both modified" files
2. Read each conflicted file, understand both versions
3. Resolve by editing - remove conflict markers (`<<<<`, `====`, `>>>>`)
4. Stage: `git add <resolved-file>`
5. Continue: `git rebase --continue`
6. If stuck: `git rebase --abort` (safe rollback)

**Recovery:**

| Situation | Command |
|-----------|---------|
| Rebase going wrong | `git rebase --abort` |
| Need original commits | `git reflog` → `git reset --hard <hash>` |
| Lost commits | `git fsck --lost-found` |

### Phase R3: Verification

```bash
git status
git log --oneline $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master)..HEAD
git diff ORIG_HEAD..HEAD --stat
```

**Push strategy:**

```
Never pushed → git push -u origin <branch>
Already pushed → git push --force-with-lease origin <branch>
ALWAYS --force-with-lease, NEVER --force
```

### Phase R4: Report

Report: strategy used, commits before/after, conflicts resolved, new history listing, push instructions.

---

## HISTORY MODE (Phase H1-H3)

### Phase H1: Determine Search Type

| Request | Search Type | Tool |
|---------|-------------|------|
| "when was X added" | PICKAXE | `git log -S` |
| "find commits changing pattern" | REGEX | `git log -G` |
| "who wrote this line" | BLAME | `git blame` |
| "when did bug start" | BISECT | `git bisect` |
| "history of file" | FILE_LOG | `git log -- path` |
| "find deleted code" | PICKAXE_ALL | `git log -S --all` |

Extract: SEARCH_TERM, FILE_SCOPE, TIME_RANGE, BRANCH_SCOPE.

### Phase H2: Execute Search

**Pickaxe (`git log -S`) - finds commits where string count changed:**

```bash
git log -S "searchString" --oneline
git log -S "searchString" -p                    # With diff context
git log -S "searchString" -- path/to/file.py    # Scoped to file
git log -S "searchString" --all --oneline       # Across all branches
git log -S "searchString" --since="2024-01-01"  # Date range
```

**Regex (`git log -G`) - finds commits where diff matches pattern:**

```bash
git log -G "pattern.*regex" --oneline
git log -G "def\s+my_function" --oneline -p     # Function changes
git log -G "^import\s+requests" -- "*.py"       # Import changes
```

**Key distinction:** `-S` finds where **count** changed (added/removed). `-G` finds where **diff** matches.

**Blame - line-by-line attribution:**

```bash
git blame path/to/file.py
git blame -L 10,20 path/to/file.py              # Specific lines
git blame -C path/to/file.py                    # Track across moves/copies
git blame -w path/to/file.py                    # Ignore whitespace
```

**Bisect - binary search for bugs:**

```bash
git bisect start
git bisect bad                                   # Current is broken
git bisect good v1.0.0                           # This version was OK

# Git checks out middle commit - test it, then:
git bisect good    # This commit is OK
git bisect bad     # This commit has the bug
# Repeat until git finds the culprit

git bisect reset                                 # Return to original state
```

**Automated bisect (with test script):**

```bash
git bisect start
git bisect bad HEAD
git bisect good v1.0.0
git bisect run pytest tests/test_specific.py     # Exit 0=good, 1-127=bad
```

**File history:**

```bash
git log --oneline -- path/to/file.py
git log --follow --oneline -- path/to/file.py    # Track across renames
git log -p -- path/to/file.py                    # With diffs
git log --all --full-history -- "**/deleted.py"   # Deleted files
git shortlog -sn -- path/to/file.py              # Author stats
```

### Phase H3: Present Results

```
SEARCH RESULTS
==============
Query: "<what user asked>"
Type: [PICKAXE | REGEX | BLAME | BISECT | FILE_LOG]
Command: git log -S "..." ...

RESULTS:
  Commit       Date           Message
  ---------    ----------     --------------------------------
  abc1234      2024-06-15     feat: add discount calculation
  def5678      2024-05-20     refactor: extract pricing logic

MOST RELEVANT: abc1234
  Author: John Doe <john@example.com>
  Files changed: 3

ACTIONS:
  - View full: git show abc1234
  - Revert: git revert abc1234
  - Related: git log --ancestry-path abc1234..HEAD
  - Cherry-pick: git cherry-pick abc1234
```

---

## Anti-Patterns

- One commit holding two atomic units → SPLIT
- Default to semantic without detection → DETECT first
- Separate test from implementation → same commit always
- Group by file type → group by feature/module
- Rebase main/master → NEVER
- `--force` instead of `--force-with-lease` → DANGEROUS
- `-S` when `-G` is appropriate → wrong results
- Blame without `-C` on moved code → wrong attribution

## See also

- `/ac/commit`: Atomic commit workflow with style detection and fixup automation
