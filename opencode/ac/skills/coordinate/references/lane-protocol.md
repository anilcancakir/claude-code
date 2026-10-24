<!-- ported-from: plugins/ac/skills/coordinate/references/lane-protocol.md sha256:745a5bb8a027c43d3819ad5e78b2540bf200ded5126e0dc20c77c075183c956e -->
# Lane Protocol

The contract between the `/ac/coordinate` coordinator (the parent) and each `ac/lane` session (a root session in its own git worktree, driving one bundle). Both sides read this file as the single source for the status block, the resume messages, the bootstrap order and the prohibitions. Field names and tokens are literal: the coordinator parses them, so a lane never renames, reorders or adds one.

Facts behind the design (the opencode host, as the ac plugin uses it): a lane is a root session created by the plugin with its worktree as its location, because a child session inherits its parent's location and could not sit in a worktree. Its own subagents (workers, explore, reviewers) inherit the worktree. The coordinator starts a lane with `ac_lane_start` and resumes it with `ac_lane_send`; when the lane's turn ends, the plugin posts the lane's last text to the coordinator as a message of the form `<lane sessionID=".." bundle=".." state="completed|failed">...</lane>`. A lane that ends a turn with a `WORKING` block is not relayed: the host wakes the lane when its own workers finish, and only its next non-`WORKING` end reaches the coordinator. `state="failed"` means the lane session itself errored; the text inside is the error, and the coordinator treats it as a `FAILED` block. A lane has no `question` tool and cannot start or message other lanes.

## Status block

Every turn of a lane ends with one status block as the last thing it writes. The reason: the coordinator sees only the lane's last text, and the lane cannot write into the main checkout, so nothing else reaches it. Each block restates the full state; the coordinator never reconstructs it from an earlier block. The block is a fenced block whose first line is `LANE STATUS`, then one `key: value` line per key, in the order below. A key that does not apply to the status is written with the value `none`.

| Key | Type | Meaning |
|---|---|---|
| `status` | enum | Where the lane stands: `WORKING`, `PLANNED`, `DECISIONS`, `BLOCKED`, `PAUSED`, `DONE` or `FAILED`. |
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

- `WORKING`: the turn ends while the lane's own workers or research agents still run. The lane is woken by their completion notification and ends a later turn with a new block. The plugin does not relay this block, and the coordinator treats the lane as live and does nothing.
- `PLANNED`: `plan.md` is written and has no open owner question. The lane waits for `EXECUTE`.
- `DECISIONS`: the plan needs owner answers first. `decisions` carries the questions; the lane waits for `ANSWERS`.
- `BLOCKED`: the lane cannot continue without the owner or the coordinator. `blocker` names why; the lane waits for `RESOLVE`.
- `DONE`: the phase's work is finished and verified. After `execute` it means every step is checked and the lane branch holds the commits; after `rebase` it means the branch sits on the new base.
- `PAUSED`: the owner paused the run. The lane started nothing after the `PAUSE` arrived, let what was already running report and recorded it (a verified step ticked, a finished wave committed), and waits for `RESUME`. The plugin relays this block like any other park.
- `FAILED`: the lane cannot finish and has no option to offer. The coordinator decides whether to re-dispatch (`attempts` in `state.json`) or drop.

### Decision entries

- `id`: short key unique within the bundle (`d1`, `d2`); the coordinator echoes it back in `ANSWERS`.
- `header`: at most 12 characters, except the plan blocker headers `Oracle CRIT?` and `Premise failed?`, which go out verbatim so the coordinator asks them under the header the gate used. The coordinator turns it into a `question` header (see `state-schema.md`).
- `question`: the full question text.
- `options`: two or more lines `<label>: <consequence>`. The label is a single token without spaces, the consequence one sentence.
- `recommended`: one of the option labels.

### Blocker classes

`class` is one of: `plan` (a planning BLOCKER gate in `plan --lane`: a missing topic, a failed research agent, an Oracle CRITICAL or a refuted premise, a plan write that failed twice), `2i` (a dependency step failed, execute Phase 2i), `2j` (three failures spanning two or more waves, execute Phase 2j), `3c` (a plan-spec issue, execute Phase 3c), `commit` (a commit the lane cannot make), `bootstrap` (a bootstrap command failed), `rebase` (a rebase conflict the lane did not resolve), `qa` (a QA lane whose app or test tool cannot run; options `Retry` and `Skip-QA`). A QA lane, started with `mode: qa` in its brief, reports `phase: qa` and runs the `qa` skill in place of plan and execute. `options` and `recommended` follow the decision-entry rules, and the labels become the `RESOLVE` argument.

### Example blocks

```
LANE STATUS
status: WORKING
bundle: b2
phase: execute
plan: /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/plan.md
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
plan: /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: 91be07d
base: 91be07d
steps: 0/4
decisions: none
blocker: none
artifacts:
  - /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/plan.md
next: waiting for EXECUTE
```

```
LANE STATUS
status: DECISIONS
bundle: b2
phase: plan
plan: /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: 91be07d
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
plan: /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/plan.md
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
  - /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/evidence/step3-fail.txt
next: waiting for RESOLVE
```

```
LANE STATUS
status: DONE
bundle: b2
phase: execute
plan: /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/plan.md
branch: lane/ship-auth/b2
head: c8d41f0
base: 91be07d
steps: 4/4
decisions: none
blocker: none
artifacts:
  - /abs/repo/.ac/worktrees/lane/ship-auth/b2/.ac/plans/b2/report.md
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

The coordinator resumes a lane with `ac_lane_send({session_id, message})`, addressing it by the session id `ac_lane_start` returned. The first token of the message is fixed and selects the behaviour; anything after it is the argument. The lane reads only the first token to dispatch, so a message never opens with prose. The plugin refuses a first token outside this list. A message waits for the lane's current turn to end (a next-turn prompt); only `STOP` and `PAUSE` steer into a turn in progress.

- `ANSWERS`: the owner's answers to a DECISIONS block. One `<id>=<label>` per line, using the ids and option labels from the block. The lane folds each answer into `plan.md` and ends with PLANNED, or DECISIONS again if the answers raised new questions.
- `EXECUTE`: run the plan. The lane loads the `execute` skill on its plan with `--lane --max-parallel <N>` (`--lane` implies auto mode, no QA pass and no push), working inside its worktree, and ends with DONE, BLOCKED or FAILED.
- `REBASE onto=<sha>`: move the lane branch onto the new integration head, then re-verify the touched scope. The lane ends with DONE (new `base` and `head`) or BLOCKED with class `rebase`. When lines follow the token, they describe a gate that failed on the integration branch after this lane's merge (the command, its exit code, an output tail): the lane rebases, fixes that failure inside its own scope, commits, reruns the command, and only then ends with DONE.
- `RESOLVE <label>`: the owner's or coordinator's choice for a BLOCKED block, one of its option labels. The lane applies it and continues the interrupted phase.
- `REVISE`: change the plan before execution. The lines after the token carry the reason (a `plan-check` failure, or a quoted roadmap goal line the plan contradicts). The lane revises `plan.md` through its Stage 5.5 review and `plan-check`, then ends with PLANNED, or DECISIONS when the revision raises an owner question. It does not count as a new attempt.
- `PAUSE`: hold the work. The plugin delivers it mid-turn, as it does `STOP`. The lane starts no new step, worker or research agent from then on. Opencode has no tool that kills a running subagent, so the lane waits for the ones already running (their completion wakes it), verifies and records what they finished exactly as its skill would (Layer A to D for a step, the wave commit when a whole wave verified), leaves every unfinished step unchecked, and ends with PAUSED. A lane that is parked (PLANNED, DECISIONS, BLOCKED, DONE) when the message arrives ends with PAUSED at once and keeps the block's pending content in mind for the resume.
- `RESUME`: continue a paused lane from its recorded state: the plan's unchecked steps under `execute`, the checkpoint under `plan`, or the block it was parked on before the pause (answer it again with that status). The lane re-reads `plan.md` and its skill state rather than its memory, since a pause can span a compaction.
- `STOP`: end the work. The lane starts no further subagent, makes no further commit, and ends with a final FAILED block whose `next` is `none`, so the coordinator never waits on a lane it stopped. Opencode has no tool that kills a running subagent, so a worker already running finishes on its own; the lane does not wait for it and does not integrate what it leaves.

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

The plugin creates the worktree and the lane branch before the lane's first turn: `git worktree add -b lane/<coord-slug>/<bundle-id> <repo>/.ac/worktrees/lane/<coord-slug>/<bundle-id> <base-sha>`. The branch already exists and is checked out, at the integration SHA the brief names, so the lane builds on the bundles already merged. Opencode does not remove a worktree that holds no changes, so the branch needs no empty commit. The lane runs the order below in the `bootstrap` phase before any planning.

1. Verify the branch: `git rev-parse --abbrev-ref HEAD` prints `lane/<coord-slug>/<bundle-id>`. A different name means the lane is not where the coordinator thinks, so end FAILED with the output in `next`; nothing was changed yet.
2. When `git check-ignore -q .ac/` fails, append `.ac/` to `$(git rev-parse --git-common-dir)/info/exclude`: the lane writes plans, evidence and reports under `.ac/` and none of it may reach a lane commit. Writing to the common dir keeps one rule for every worktree and leaves tracked files untouched.
3. Run the brief's bootstrap commands (dependency install, env files). A fresh worktree carries neither, so a failing command here ends the turn with BLOCKED, class `bootstrap`.

## Prohibitions

- No `git push`, and the lane loads `execute` with `--lane`, which implies no push. Only the coordinator, after an owner-approved `Push?` answer, publishes anything.
- No `git merge`, into `coord/<slug>` or anywhere else; a lane moves its base only through a rebase message. The coordinator is the only integrator, which keeps the integration order and conflict handling in one place. The lane's permissions deny both verbs; the rule is stated so the lane does not look for a way around them.
- No `question`. The lane has no such tool, and an owner question reaches the owner only through a DECISIONS or BLOCKED block.
- No `ac_lane_start` or `ac_lane_send`, and no second worktree. The lane is already isolated, and a second worktree would leave the status block's paths pointing at a directory the coordinator does not know.
- No writes outside the lane worktree. The coordinator is the only writer of `.ac/coord/<slug>/`; the lane reports through its status block and the files under its own `.ac/`.
