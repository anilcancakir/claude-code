# Lane Protocol

The contract between the `/ac:coordinate` coordinator (the parent) and each `ac:lane` subagent (a worktree-isolated child driving one bundle). Both sides read this file as the single source for the status block, the resume messages, the bootstrap order and the prohibitions. Field names and tokens are literal: the coordinator parses them, so a lane never renames, reorders or adds one.

Facts behind the design (measured on Claude Code 2.1.303): a background subagent's parent receives only the child's final message; subagents never get `AskUserQuestion`; an `isolation: worktree` worktree branches from the default branch, not from the coordinator's HEAD; a worktree with no tracked changes is removed when the subagent finishes; at most 20 subagents run at once across the whole session. Lanes are addressed by agent id, never by a spawn `name`, because with agent teams enabled a named spawn becomes a teammate in the main checkout.

## Status block

Every turn of a lane ends with one status block as the last thing it writes. The reason: the coordinator sees only the lane's last message, and the lane cannot write into the main checkout, so nothing else reaches it. Each block restates the full state; the coordinator never reconstructs it from an earlier block. The block is a fenced block whose first line is `LANE STATUS`, then one `key: value` line per key, in the order below. A key that does not apply to the status is written with the value `none`.

| Key | Type | Meaning |
|---|---|---|
| `status` | enum | Where the lane stands. Values below. |
| `bundle` | string | The bundle id from the coordinator's `state.json`. |
| `phase` | enum | `bootstrap`, `plan`, `execute` or `rebase`: the phase the turn worked in. |
| `plan` | path or `none` | Absolute path to the bundle's `plan.md` inside the lane worktree. |
| `branch` | string | `lane/<coord-slug>/<bundle-id>`. |
| `head` | sha | The lane branch HEAD at turn end. |
| `base` | sha | The integration SHA the branch was started or last rebased from. |
| `steps` | `<checked>/<total>` | Checked and total step boxes in the lane's `plan.md`; `0/0` before a plan exists. |
| `decisions` | list | DECISIONS only. One entry per owner question: `id`, `header`, `question`, `options`, `recommended`. |
| `blocker` | map | BLOCKED only: `class`, `header` (the gate's own header, verbatim, for example `Oracle CRIT?` or `Premise failed?`), `question`, `options`, `recommended`. |
| `artifacts` | list | Absolute paths to the report and evidence files the turn produced. |
| `next` | string | One line: what the lane expects to happen next and which resume message it waits for. |

### Status values

- `WORKING`: the turn ends while the lane's own workers or research agents still run. The lane is woken by their completion notification and ends a later turn with a new block. The coordinator treats the lane as live and does nothing.
- `PLANNED`: `plan.md` is written and has no open owner question. The lane waits for `EXECUTE`.
- `DECISIONS`: the plan needs owner answers first. `decisions` carries the questions; the lane waits for `ANSWERS`.
- `BLOCKED`: the lane cannot continue without the owner or the coordinator. `blocker` names why; the lane waits for `RESOLVE`.
- `DONE`: the phase's work is finished and verified. After `execute` it means every step is checked and the lane branch holds the commits; after `rebase` it means the branch sits on the new base.
- `FAILED`: the lane cannot finish and has no option to offer. The coordinator decides whether to re-dispatch (`attempts` in `state.json`) or drop.

### Decision entries

- `id`: short key unique within the bundle (`d1`, `d2`); the coordinator echoes it back in `ANSWERS`.
- `header`: at most 12 characters, except the plan blocker headers `Oracle CRIT?` and `Premise failed?`, which go out verbatim because the question-timeout hook matches them exactly. The coordinator turns it into an `AskUserQuestion` header (see `state-schema.md`).
- `question`: the full question text.
- `options`: two or more lines `<label>: <consequence>`. The label is a single token without spaces, the consequence one sentence.
- `recommended`: one of the option labels.

### Blocker classes

`class` is one of: `plan` (a planning BLOCKER gate in `ac:plan --lane`: a missing topic, a failed research agent, an Oracle CRITICAL or a refuted premise, a plan write that failed twice), `2i` (a dependency step failed, execute Phase 2i), `2j` (three failures spanning two or more waves, execute Phase 2j), `3c` (a plan-spec issue, execute Phase 3c), `commit` (a commit the lane cannot make), `bootstrap` (a bootstrap command failed), `rebase` (a rebase conflict the lane did not resolve). `options` and `recommended` follow the decision-entry rules, and the labels become the `RESOLVE` argument.

### Example blocks

```
LANE STATUS
status: WORKING
bundle: b2
phase: execute
plan: /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: 4f1c2aa
base: 91be07d
steps: 1/4
decisions: none
blocker: none
artifacts: none
next: wave 2 workers still running; I will end a later turn with a new block
```

```
LANE STATUS
status: PLANNED
bundle: b2
phase: plan
plan: /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: 4f1c2aa
base: 91be07d
steps: 0/4
decisions: none
blocker: none
artifacts:
  - /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/plan.md
next: waiting for EXECUTE
```

```
LANE STATUS
status: DECISIONS
bundle: b2
phase: plan
plan: /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: 4f1c2aa
base: 91be07d
steps: 0/4
decisions:
  - id: d1
    header: Token store
    question: Where should session tokens live?
    options:
      - cookie: simpler, needs CSRF handling
      - header: stateless, the client must keep the token
    recommended: cookie
blocker: none
artifacts: none
next: waiting for ANSWERS
```

```
LANE STATUS
status: BLOCKED
bundle: b2
phase: execute
plan: /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: 7ac03de
base: 91be07d
steps: 2/4
decisions: none
blocker:
  class: 2j
  question: Three steps failed across two waves; continue or stop?
  options:
    - retry: re-run the failed steps one tier up
    - stop: leave the branch as is and report FAILED
  recommended: retry
artifacts:
  - /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/evidence/step3-fail.txt
next: waiting for RESOLVE
```

```
LANE STATUS
status: DONE
bundle: b2
phase: execute
plan: /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: c8d41f0
base: 91be07d
steps: 4/4
decisions: none
blocker: none
artifacts:
  - /abs/repo/.claude/worktrees/agent-a1b2c3d4/.ac/plans/b2/report.md
next: waiting for REBASE or the coordinator's merge
```

```
LANE STATUS
status: FAILED
bundle: b2
phase: bootstrap
plan: none
branch: lane/ship-auth/b2
head: 91be07d
base: 91be07d
steps: 0/0
decisions: none
blocker: none
artifacts: none
next: none
```

## Resume messages

The coordinator resumes a lane by agent id with `SendMessage`. The first token of the message is fixed and selects the behaviour; anything after it is the argument. The lane reads only the first token to dispatch, so a message never opens with prose.

- `ANSWERS`: the owner's answers to a DECISIONS block. One `<id>=<label>` per line, using the ids and option labels from the block. The lane folds each answer into `plan.md` and ends with PLANNED, or DECISIONS again if the answers raised new questions.
- `EXECUTE`: run the plan. The lane calls the `ac:execute` skill on its plan with `--lane --max-parallel <N>` (`--lane` implies auto mode, no QA pass and no push), working inside its worktree, and ends with DONE, BLOCKED or FAILED.
- `REBASE onto=<sha>`: move the lane branch onto the new integration head, then re-verify the touched scope. The lane ends with DONE (new `base` and `head`) or BLOCKED with class `rebase`. When lines follow the token, they describe a gate that failed on the integration branch after this lane's merge (the command, its exit code, an output tail): the lane rebases, fixes that failure inside its own scope, commits, reruns the command, and only then ends with DONE.
- `RESOLVE <label>`: the owner's or coordinator's choice for a BLOCKED block, one of its option labels. The lane applies it and continues the interrupted phase.
- `REVISE`: change the plan before execution. The lines after the token carry the reason (a `plan-check` failure, or a quoted roadmap goal line the plan contradicts). The lane revises `plan.md` through its Stage 5.5 review and `plan-check`, then ends with PLANNED, or DECISIONS when the revision raises an owner question. It does not count as a new attempt.
- `STOP`: end the work. The lane stops its own workers and research agents, makes no further commit, and ends with a final FAILED block whose `next` is `none`, so the coordinator never waits on a lane it stopped.

Examples:

```
ANSWERS
d1=cookie
d2=keep
```

```
EXECUTE
```

```
REBASE onto=a93f5b1
```

```
RESOLVE retry
```

```
STOP
```

## Bootstrap

A fresh lane worktree starts at the default branch, not at the integration branch, and Claude Code removes a worktree that holds no changes when the subagent finishes. The order below handles both and is not interchangeable. The lane runs it in the `bootstrap` phase before any planning.

1. `git switch -C lane/<coord-slug>/<bundle-id> <base-sha>`: puts the worktree on the lane branch at the integration SHA the brief names, so the lane builds on the bundles already merged rather than on the default branch.
2. `git commit --allow-empty -m "chore(lane): start <bundle-id>"`: gives the branch a commit past the worktree's creation point, so Claude Code keeps the worktree across turns and a resume does not land in an unisolated checkout.
3. When `git check-ignore -q .ac/` fails, append `.ac/` to `$(git rev-parse --git-common-dir)/info/exclude`: the lane writes plans, evidence and reports under `.ac/` and none of it may reach a lane commit. Writing to the common dir keeps one rule for every worktree and leaves tracked files untouched.
4. Run the brief's bootstrap commands (dependency install, env files). A fresh worktree carries neither, so a failing command here ends the turn with BLOCKED, class `bootstrap`.

## Prohibitions

- No `git push`, and the lane calls `ac:execute` with `--lane`, which implies no push. Only the coordinator, after an owner-approved `Push?` answer, publishes anything.
- No `git merge`, into `coord/<slug>` or anywhere else; a lane moves its base only through a rebase message. The coordinator is the only integrator, which keeps the integration order and conflict handling in one place.
- No `AskUserQuestion`. Subagents have no such tool, and an owner question reaches the owner only through a DECISIONS or BLOCKED block.
- No `EnterWorktree`. The lane is already isolated, and entering a second worktree would leave the status block's paths pointing at a directory the coordinator does not know.
- No writes outside the lane worktree. The coordinator is the only writer of `.ac/coord/<slug>/`; the lane reports through its status block and the files under its own `.ac/`.
