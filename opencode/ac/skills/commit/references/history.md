<!-- ported-from: plugins/ac/skills/commit/references/history.md sha256:98eaaf9dc73ed5a3322f48769fd26e2bc36e7604be8ce23c4e6afcd2d22bab01 -->
# History mode

Finding when, where and by whom a change entered the code. Read-only: nothing here rewrites or pushes.

## 1. Pick the search

| Request | Search | Command |
|---|---|---|
| when was X added or removed | pickaxe | `git log -S` |
| commits whose diff matches a pattern | regex | `git log -G` |
| who wrote this line | blame | `git blame` |
| when did the bug start | bisect | `git bisect` |
| history of a file | file log | `git log -- path` |
| find deleted code | pickaxe on all refs | `git log -S --all` |

`-S` finds commits where the number of occurrences of a string changed; `-G` finds commits whose diff matches a regex. Pick `-S` for "when did this appear", `-G` for "which commits touched code shaped like this". Extract the search term, file scope, time range and branch scope from the request first.

## 2. Run it

```bash
# pickaxe
git log -S "searchString" --oneline
git log -S "searchString" -p                      # with the diff
git log -S "searchString" -- path/to/file.py      # scoped to a file
git log -S "searchString" --all --oneline         # every branch
git log -S "searchString" --since="2024-01-01"

# regex
git log -G "def\s+my_function" --oneline -p
git log -G "^import\s+requests" -- "*.py"

# blame
git blame path/to/file.py
git blame -L 10,20 path/to/file.py                # specific lines
git blame -C path/to/file.py                      # follow moved or copied code
git blame -w path/to/file.py                      # ignore whitespace

# file history
git log --oneline -- path/to/file.py
git log --follow --oneline -- path/to/file.py     # across renames
git log --all --full-history -- "**/deleted.py"   # deleted files
git shortlog -sn -- path/to/file.py               # author counts
```

Bisect, by hand or automated (exit 0 is good, 1 to 127 is bad):

```bash
git bisect start
git bisect bad                    # the current commit is broken
git bisect good v1.0.0            # this one was fine
# test each commit git checks out, then mark it: git bisect good | git bisect bad
git bisect reset                  # back to where you started

git bisect start && git bisect bad HEAD && git bisect good v1.0.0
git bisect run pytest tests/test_specific.py
```

Blame without `-C` credits the commit that moved code, not the one that wrote it. A remote repository is read through `ac/github-cli`, not here.

## 3. Present

```
SEARCH RESULTS
Query: <what the user asked>
Command: git log -S "..." ...

  abc1234  2024-06-15  feat: add discount calculation   <- most relevant
  def5678  2024-05-20  refactor: extract pricing logic

abc1234: <author>, <N> files. Next: git show abc1234 | git revert abc1234 | git cherry-pick abc1234
```
