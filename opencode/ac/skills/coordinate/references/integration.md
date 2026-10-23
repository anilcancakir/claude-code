<!-- ported-from: plugins/ac/skills/coordinate/references/integration.md sha256:07747d220f33eac0700e958845ce252424221b3bfd7e598df52658d22168d8ba -->
# Integration

How `/ac/coordinate` moves one DONE bundle into the local `coord/<slug>` branch, and how it tears a lane down. Read
it at Phase 6d, and again after a compaction when the marker says `phase: "integrate"`. Message tokens and block
fields are the ones in `lane-protocol.md`; state fields are the ones in `state-schema.md`.

Names used below: `<wt>` is the integration worktree `<repo>/.ac/worktrees/coord-<slug>`; `<lane wt>` and
`<lane branch>` are the bundle's `worktree` and `branch` in `state.json` (`<repo>/.ac/worktrees/lane/<slug>/<id>` and
`lane/<slug>/<id>`, as `ac_lane_start` returned them); `<head>` is `integration_head`. Every "send" below is
`ac_lane_send({session_id: <lane_session_id>, message})`.

Bundles integrate one at a time, and only once every `depends_on` entry is `merged`; among several ready bundles
the roadmap order decides. Each bundle runs the steps below to the end before the next one starts, because every
merge moves `<head>` and the next bundle has to be checked against the new one.

## Per DONE bundle, in order

1. **Confirm DONE.** The lane's latest block reads `status: DONE`, its `branch` equals `<lane branch>`, and its
   `steps` reads `N/N` with N equal to the bundle's `steps_total` in `state.json` (the total `plan-check` printed
   before `EXECUTE`, Phase 6c). A count short of that total is not done, whatever the status says: resume the lane
   with `EXECUTE` and wait.

2. **Base check.** When the block's `base` is not `<head>`, send the lane `REBASE onto=<head>` and end the
   turn with a wait status. Its next DONE starts again at step 1.
   - The lane answers with `BLOCKED`, class `rebase`, when it could not resolve the rebase. Ask the owner one
     `question`, header `Conflict?`, carrying the bundle id, the conflicting files from the block's
     `question`, and its options with `recommended` marked. Send `RESOLVE <label>` with the exact label chosen.
     Every question waits for the owner; a merge order is not something to settle on a guess.

3. **Merge.** `git -C <wt> merge --ff-only <lane branch>`. Fast-forward only, so the integration branch is always a
   sequence of lane branches each rebased onto the one before, and no merge commit hides a resolution nobody
   reviewed. A refusal means the base moved since step 2: go back to step 2.

4. **Gates.** Run every command-tier criterion of `.ac/coord/<slug>/criteria.md` from the repository root, exactly
   as written; each carries the `cd <wt> &&` prefix, so it runs against the integration branch. Compare each exit
   code with its `expected_exit_code`. A gate that already failed at the Phase 5 baseline is compared with that
   baseline, not counted against this bundle. Capture the exit code of the gate itself: a gate piped into `tail`
   reports `tail`'s, and the agent shell is zsh, where `${PIPESTATUS[0]}` is empty. Run it as
   `set -o pipefail; <criterion> 2>&1 | tail -20`, or redirect to a log and `echo "exit=$?"` before reading the tail.
   A long gate (a full suite, `bin/check`) runs as a background shell with the turn ended; its completion wakes you,
   and the plugin's stop guard counts it as running work.

5. **On a gate failure, the lane fixes it.** Never patch `<wt>` yourself: the fix then has no plan, no review and
   no lane that owns it. First put the integration branch back with `git -C <wt> reset --keep <head>` (`<head>` has
   not moved yet). Then resume the lane with a fix request:
   - When the lane's last block was BLOCKED and its options cover the failure, send `RESOLVE <label>`.
   - Otherwise send `REBASE onto=<head>` followed, on later lines, by the failing command, its exit code and the
     last lines of its output. The lane re-verifies on the same base and reports DONE or BLOCKED.

   The second gate failure for the same bundle goes to the owner as `Lane block?` with `retry` (one more fix
   request), `drop` (the bundle and its dependents are dropped) and `stop` (the Abort branch). Two lane passes at
   one gate are where a third stops paying for itself.

6. **Advance the head.** Set `integration_head` to `git -C <wt> rev-parse HEAD` in `state.json` and append one
   `events.jsonl` line with the old head, the new head and the gate results.

7. **Archive.** Copy the lane's plan directory and report into the run directory, then confirm the copy:

   ```
   mkdir -p .ac/coord/<slug>/bundles/<id>
   cp -R <lane wt>/.ac/plans/<id>/. .ac/coord/<slug>/bundles/<id>/
   diff -rq <lane wt>/.ac/plans/<id> .ac/coord/<slug>/bundles/<id>
   ```

   The report lives inside the plan directory (`report.md`). Any path in the DONE block's `artifacts` outside that
   directory is copied into `bundles/<id>/` as well and compared the same way. `diff -rq` printing nothing is the
   only evidence that sets `archived: true`; output from it means the copy is incomplete, so copy again and do not
   go on to step 8 until it prints nothing.

8. **Remove the worktree.** The lane's final block has arrived and the archive is verified, so nothing will resume
   it: run `git worktree remove <lane wt>`, never with `--force`. The lane's commits live on in the
   integration branch and its plan in the archive; anything that makes a plain removal refuse (an untracked or
   modified file) is work nobody archived. On a refusal, keep `worktree` set, add one `events.jsonl` line naming the
   files `git -C <lane wt> status --short` lists, and leave it for the final report. Otherwise set `worktree` to
   `null`.

9. **Delete the lane branch,** and only now that it is merged and its worktree gone:
   `git -C <wt> branch -d <lane branch>`. Run from `<wt>` because `-d` checks the branch is merged into the current
   HEAD, which there is `coord/<slug>`. A branch still checked out in a refused worktree stays. Set the bundle to
   `merged`.

10. **Notify intersecting lanes.** List the files the merge brought in with
    `git -C <wt> diff --name-only <old head> <new head>`. For every live bundle whose `hotspots` intersect that list
    (a hotspot naming a directory matches every file under it), send `REBASE onto=<new head>` when the lane is
    parked at `planned`, so it executes on the new base. A lane that is `planning` or in `decisions` gets the rebase
    before its `EXECUTE` (Phase 6c), and an `executing` lane gets it at step 2 when it reports DONE: a rebase sent
    mid-execute would end its execute phase early. A lane whose hotspots miss the merged files is not disturbed.

Merges stay local. Nothing here pushes; the one push is the `Push?` gate at Phase 8.

## Resuming after a compaction

`state.json` plus git says which step a bundle stopped at, so nothing is repeated or skipped:

| Fact | Resume at |
|---|---|
| status `done`, `git -C <wt> merge-base --is-ancestor <lane head> HEAD` fails | step 1 |
| the lane head is in `<wt>` HEAD but `integration_head` is the old head | step 4 (gates), then 6 |
| `integration_head` advanced, `archived` false | step 7 |
| `archived` true, `worktree` still set and the directory exists | step 8 |
| `worktree` null or refused, status not yet `merged` | step 9 |
| status `merged` | step 10 if `events.jsonl` has no notify line for it, else done |

## Tearing down a failed lane

A lane that ended FAILED holds no mergeable work, but its plan and evidence still explain why it failed. Archive
as in step 7 into `bundles/<id>-failed-<attempts>/` (beside, not inside, `bundles/<id>/`, so a later successful
attempt's `diff -rq` compares like with like), confirm with `diff -rq`, then `git worktree remove <lane wt>`
without `--force`. Only when the worktree is gone can `git -C <wt> branch -D <lane branch>` drop the unmerged
branch (an unmerged branch needs the capital `-D`; the archive already holds its plan) and a fresh lane re-create
the branch name and worktree path. A refused removal leaves both in place and the bundle is dropped rather than
re-dispatched. A lane that ended `state="failed"` (its session errored) is torn down the same way.

## What never happens here

- `git worktree remove --force`: a refusing worktree holds unarchived work.
- A standing `cd` into a worktree: `<wt>` is driven with `git -C` and `(cd <wt> && <command>)` subshells, so the
  coordinator's own working directory stays the main checkout, where `.ac/` and the run directory live.
- `git push`, from any worktree, before the `Push?` answer.
- An edit to a source file in `<wt>` or `<lane wt>`.
