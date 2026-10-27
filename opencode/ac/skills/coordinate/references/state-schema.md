<!-- ported-from: plugins/ac/skills/coordinate/references/state-schema.md sha256:c4ae1ae83e4286ee9c1bcc1abc7d0ac7e779064c2fda4b0f5a212269cb3dc1b8 -->
# Coordinate State Schema

On-disk shapes behind `/ac/coordinate`: a state marker naming the live run, and a run directory holding the roadmap, the contract, the bundle table and the log. The layout mirrors `criteria-schema.md` in this directory (a criteria file plus a run directory). The lane side of the contract lives in `lane-protocol.md` beside it.

The coordinator is the single writer of everything here. A lane never writes under `.ac/coord/<slug>/` and never touches the marker: it reports through its status block, and the coordinator turns that into a `state.json` update. Two writers would race on `state.json`, and a lane in its own worktree cannot reach the main checkout's `.ac/` anyway.

## `.ac/state/active-coordinate.json`

Path: `.ac/state/active-coordinate.json`. Written once when a run starts, refreshed on `phase` and `note`, removed on every terminal branch.

```json
{
  "slug": "<coordinate-run slug>",
  "session_id": "<root_session_id from ac_session>",
  "harness": "opencode",
  "started_at": "<output of date -u +%Y-%m-%dT%H:%M:%SZ>",
  "phase": "roadmap",
  "note": "<one-line resume hint>"
}
```

- `slug`: the run slug, matching the `<slug>` segment of `.ac/coord/<slug>/`. Names which run is live and which `state.json` a resumed session reads.
- `session_id`: `root_session_id` exactly as the `ac_session` tool returned it, never derived or recalled, written once. The plugin's coordinate stop guard acts only in the session whose root matches it, so a marker left by another session cannot nudge an unrelated one.
- `harness`: exactly `"opencode"`. A marker without it was written by Claude Code and the plugin leaves it alone.
- `started_at`: written once and never refreshed. It is the age bound for treating a stale marker as abandoned. Take it from `date -u +%Y-%m-%dT%H:%M:%SZ`, never from your own sense of the time.
- `phase`: one of `roadmap` (drafting and review, up to the `Roadmap?` approval), `dispatch` (lanes planning and executing), `integrate` (merging done bundles into the integration branch), `gating` (the verifier runs and the owner is asked about the push), `paused` (the owner paused the run; the `note` names the phase to return to).
- `note`: a one-line resume hint in plain prose, refreshed with the phase, read back after a compaction or a restart.

Removed on every terminal branch: a verdict written, an owner abort, or an error that ends the run. A marker that outlives its run makes the stop guard read the run as unfinished and send continuations into it.

## `.ac/coord/<slug>/`

| Path | Writer and timing | Contents |
|---|---|---|
| `state.json` | coordinator, rewritten on every status change | The bundle table, below. |
| `roadmap.md` | coordinator, once the `Roadmap?` answer approves it | The oracle-reviewed roadmap: bundles, dependencies, hotspots. |
| `research.md` | coordinator, at the end of Phase 2 | The research digest every lane brief names: per surface the `file:line` anchors, conventions, gate and bootstrap commands, external facts with URLs. |
| `criteria.md` | coordinator, before dispatch | The verifier's contract for the whole run, in the shape of `criteria-schema.md`. |
| `events.jsonl` | coordinator, append-only | One JSON object per line for each lane message and status change (mid-run contract changes as `criteria_relocked` and `bundle_added`), with its time under `t` from `date -u +%Y-%m-%dT%H:%M:%SZ` run in the appending command. Never rewritten or truncated. |
| `bundles/<id>/` | coordinator, once per bundle at archive | Copy of the bundle's plan directory and report, taken from the lane worktree before the worktree is removed. |
| `verdict.md` | coordinator, once at the end | The verifier's returned body. Its presence marks the run as finished. |

### `state.json`

```json
{
  "slug": "ship-auth",
  "base_sha": "91be07d",
  "integration_branch": "coord/ship-auth",
  "integration_head": "91be07d",
  "max_lanes": 2,
  "max_workers": 2,
  "bundles": [
    {
      "id": "b1",
      "title": "Token storage",
      "depends_on": [],
      "merge_after": [],
      "hotspots": ["src/auth/session.ts"],
      "status": "pending",
      "lane_session_id": null,
      "worktree": null,
      "branch": null,
      "head": null,
      "plan_slug": null,
      "steps_total": null,
      "archived": false,
      "attempts": 0,
      "revise_rounds": 0
    }
  ],
  "owner_queue": []
}
```

Top level:

- `slug`: the run slug.
- `base_sha`: the commit the integration branch was cut from, fixed for the run.
- `integration_branch`: `coord/<slug>`, the local branch bundles merge into.
- `integration_head`: the integration branch tip; moves on every merge. It is the `onto=` value of a `REBASE` message and the `base_sha` of a new lane's `ac_lane_start`.
- `max_lanes`: the most bundles the coordinator keeps in `planning` or `executing` at once: `--lanes` (default 2), lowered to the installed preset's cap when `ac_lane_start` reports a smaller `max_lanes` (2 under the codefast preset, 3 under the claude preset, 1 under gpt-unlimited). The plugin does not enforce it; the coordinator does, from this file.
- `max_workers`: parallel workers per lane, passed to the lane as `--max-parallel`. Default 2 (SKILL.md, Phase 0); the claude preset tolerates 3.
- `bundles`: the bundle list, shape below.
- `owner_queue`: bundle ids whose DECISIONS or BLOCKED block still waits on the owner, in arrival order. The coordinator drains it into one batched question round instead of one prompt per lane.

Per bundle:

- `id`: short stable key (`b1`), used in branch names, archive paths and question headers.
- `title`: one-line name from the roadmap.
- `depends_on`: ids of bundles that must be `merged` before this one is dispatched.
- `merge_after`: ids of bundles that must be `merged` or `dropped` before this one is integrated, with no effect on
  dispatch: the roadmap's merge order for bundles that touch one file without needing each other. Absent or empty
  means no ordering.
- `hotspots`: files or areas the bundle is expected to touch, used to keep overlapping bundles out of the same wave.
- `status`: one of the values below.
- `lane_session_id`: the `session_id` `ac_lane_start` returned; the address every `ac_lane_send` uses. `null` until dispatched.
- `worktree`: absolute path of the lane worktree, from the `ac_lane_start` result (`<repo>/.ac/worktrees/lane/<slug>/<id>`); `null` until dispatched, and again after removal.
- `branch`: `lane/<slug>/<id>`, from the same result; `null` until dispatched.
- `head`: the lane branch HEAD from the latest status block.
- `plan_slug`: the slug of the plan directory under the lane's `.ac/plans/`; `null` until a plan exists.
- `steps_total`: the step total `plan-check` printed for the bundle's plan, at its exit-0 run in Phase 6c or, for a DONE that the 6c `execute` option let past a failing `plan-check`, in Phase 6a; the N that integration compares the DONE block's `steps` against. `null` until then, and reset to `null` whenever a lane is dispatched, because a re-dispatched lane plans afresh.
- `archived`: `true` once the plan directory and report are copied into `bundles/<id>/` and checked with `diff -rq`. A worktree is removed only after this, never with `--force`.
- `attempts`: how many lanes were dispatched for this bundle.
- `revise_rounds`: how many `REVISE` messages this attempt received, at most 2 before the owner is asked.

### Bundle statuses

- `pending`: not dispatched yet.
- `planning`: a lane is bootstrapping or drafting the plan. With `executing`, the status the plugin's stop guard reads as a lane that will wake the coordinator.
- `decisions`: the lane ended with DECISIONS; the bundle is in `owner_queue`.
- `planned`: the lane ended with PLANNED and waits for `EXECUTE`.
- `executing`: the lane is running the plan.
- `blocked`: the lane ended with BLOCKED; the bundle is in `owner_queue`.
- `done`: the lane ended with DONE; the branch is ready to integrate.
- `merged`: the branch is in the integration branch and archived. Closed.
- `dropped`: the owner or coordinator removed the bundle. Closed.
- `paused`: the lane ended with PAUSED after the owner paused the run; `paused_from` holds the status it resumes to.
- `failed`: the lane ended with FAILED (or its relay carried `state="failed"`) and the coordinator has not yet re-dispatched or dropped it.

A closed status (`merged`, `dropped`) never changes again.

## `question` headers

Every header the coordinator passes to `question` is at most 12 characters, matching the headers the lanes return. The fixed ones are `Roadmap?` (approve the roadmap), `Push?` (the one owner-approved push), `Lane block?` (a BLOCKED lane) and `Conflict?` (an integration merge conflict); a lane `plan` blocker that carries `Oracle CRIT?` or `Premise failed?` is asked under that header verbatim. A bundle decision header is the bundle id followed by the lane's `header`, cut to 12 characters.
