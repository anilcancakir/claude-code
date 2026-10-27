# Coordinate State Schema

On-disk shapes behind `/ac:coordinate`: a state marker naming the live run, and a run directory holding the roadmap, the contract, the bundle table and the log. The layout mirrors `${CLAUDE_PLUGIN_ROOT}/skills/auto/references/criteria-schema.md` (marker plus run directory). The lane side of the contract lives in `${CLAUDE_PLUGIN_ROOT}/skills/coordinate/references/lane-protocol.md`.

The coordinator is the single writer of everything here. A lane never writes under `.ac/coord/<slug>/` and never touches the marker: it reports through its status block, and the coordinator turns that into a `state.json` update. Two writers would race on `state.json`, and a lane in its own worktree cannot reach the main checkout's `.ac/` anyway.

## `.ac/state/active-coordinate.json`

Path: `.ac/state/active-coordinate.json`. Written once when a run starts, refreshed on `phase` and `note`, removed on every terminal branch.

```json
{
  "slug": "<coordinate-run slug>",
  "session_id": "<the session id the skill body gives you>",
  "started_at": "<output of date -u +%Y-%m-%dT%H:%M:%SZ>",
  "phase": "roadmap",
  "note": "<one-line resume hint>"
}
```

- `slug`: the run slug, matching the `<slug>` segment of `.ac/coord/<slug>/`. Names which run is live and which `state.json` a resumed session reads.
- `session_id`: the current session id, written once; a guard scopes its behaviour to the session that started the run.
- `started_at`: written once and never refreshed. It is the age bound for treating a stale marker as abandoned.
- `phase`: one of `roadmap` (drafting and review, up to the `Roadmap?` approval), `dispatch` (lanes planning and executing), `integrate` (merging done bundles into the integration branch), `gating` (the verifier runs and the owner is asked about the push).
- `note`: a one-line resume hint in plain prose, refreshed with the phase, read back after a compaction or a restart.

Removed on every terminal branch: a verdict written, an owner abort, or an error that ends the run. A marker that outlives its run makes a guard read the run as unfinished.

## `.ac/coord/<slug>/`

| Path | Writer and timing | Contents |
|---|---|---|
| `state.json` | coordinator, rewritten on every status change | The bundle table, below. |
| `roadmap.md` | coordinator, once the `Roadmap?` answer approves it | The oracle-reviewed roadmap: bundles, dependencies, hotspots. |
| `research.md` | coordinator, at the end of Phase 2 | The research digest every lane brief names: per surface the `file:line` anchors, conventions, gate and bootstrap commands, external facts with URLs. |
| `criteria.md` | coordinator, before dispatch | The verifier's contract for the whole run, in the shape of `criteria-schema.md`. |
| `events.jsonl` | coordinator, append-only | One JSON object per line for each lane message and status change. Never rewritten or truncated. Mid-run contract changes log as `criteria_relocked` (row, rev, owner answer) and `bundle_added` (id, goal, the owner answer that approved it). |
| `bundles/<id>/` | coordinator, once per bundle at archive | Copy of the bundle's plan directory and report, taken from the lane worktree before the worktree is removed. |
| `verdict.md` | coordinator, once at the end | The verifier's returned body. Its presence marks the run as finished. |

### `state.json`

```json
{
  "slug": "ship-auth",
  "base_sha": "91be07d",
  "integration_branch": "coord/ship-auth",
  "integration_head": "91be07d",
  "max_lanes": 3,
  "max_workers": 5,
  "bundles": [
    {
      "id": "b1",
      "title": "Token storage",
      "depends_on": [],
      "merge_after": [],
      "hotspots": ["src/auth/session.ts"],
      "status": "pending",
      "lane_agent_id": null,
      "worktree": null,
      "branch": null,
      "head": null,
      "plan_slug": null,
      "steps_total": null,
      "archived": false,
      "attempts": 0
    }
  ],
  "owner_queue": []
}
```

Top level:

- `slug`: the run slug.
- `base_sha`: the commit the integration branch was cut from, fixed for the run.
- `integration_branch`: `coord/<slug>`, the local branch bundles merge into.
- `integration_head`: the integration branch tip; moves on every merge. It is the `onto=` value of a `REBASE` message and the `<base-sha>` of a new lane's bootstrap.
- `max_lanes`: concurrent lane cap, default 3. The session allows 20 subagents in all, and each lane also runs its own workers, so the cap leaves room for them.
- `max_workers`: parallel workers per lane, at most 5.
- `bundles`: the bundle list, shape below.
- `owner_queue`: bundle ids whose DECISIONS or BLOCKED block still waits on the owner, in arrival order. The coordinator drains it into one batched question round instead of one prompt per lane.
- `owner_asked`: bundle ids from `owner_queue` whose blocker question already timed out and waited. They are not asked again until a user message arrives, then cleared as the owner answers. Absent or empty means nothing is parked.
- Per bundle `revise_rounds`: how many `REVISE` messages this attempt received, at most 2 before the owner is asked.
- `timed_out`: optional list of `{bundle, question, choice}` objects, one per question that continued on an AFK timeout with its Recommended option, each also logged in `events.jsonl` as `timed out, not user-approved`. Absent or empty when every answer came from the owner.

Per bundle:

- `id`: short stable key (`b1`), used in branch names, archive paths and question headers.
- `title`: one-line name from the roadmap.
- `depends_on`: ids of bundles that must be `merged` before this one is dispatched.
- `merge_after`: ids of bundles that must be `merged` or `dropped` before this one is integrated, with no effect on
  dispatch: the roadmap's merge order for bundles that touch one file without needing each other. Absent or empty
  means no ordering.
- `hotspots`: files or areas the bundle is expected to touch, used to keep overlapping bundles out of the same wave.
- `status`: one of the values below.
- `lane_agent_id`: the subagent id the lane is addressed by; `null` until dispatched.
- `worktree`: absolute path of the lane worktree; `null` until the lane reports it, and again after removal.
- `branch`: `lane/<slug>/<id>`; `null` until dispatched.
- `head`: the lane branch HEAD from the latest status block.
- `plan_slug`: the slug of the plan directory under the lane's `.ac/plans/`; `null` until a plan exists.
- `steps_total`: the step total `plan-check` printed for the bundle's plan, at its exit-0 run in Phase 6c or, for a DONE that the 6c `execute` option let past a failing `plan-check`, in Phase 6a; the N that integration compares the DONE block's `steps` against. `null` until then, and reset to `null` whenever a lane is dispatched, because a re-dispatched lane plans afresh.
- `archived`: `true` once the plan directory and report are copied into `bundles/<id>/` and checked with `diff -rq`. A worktree is removed only after this, never with `--force`.
- `attempts`: how many lanes were dispatched for this bundle.

### Bundle statuses

- `pending`: not dispatched yet.
- `planning`: a lane is bootstrapping or drafting the plan.
- `decisions`: the lane ended with DECISIONS; the bundle is in `owner_queue`.
- `planned`: the lane ended with PLANNED and waits for `EXECUTE`.
- `executing`: the lane is running the plan.
- `blocked`: the lane ended with BLOCKED; the bundle is in `owner_queue`.
- `done`: the lane ended with DONE; the branch is ready to integrate.
- `merged`: the branch is in the integration branch and archived. Closed.
- `dropped`: the owner or coordinator removed the bundle. Closed.
- `failed`: the lane ended with FAILED and the coordinator has not yet re-dispatched or dropped it.

A closed status (`merged`, `dropped`) never changes again.

## AskUserQuestion headers

Every header the coordinator passes to `AskUserQuestion` is at most 12 characters, the tool's limit. The fixed ones are `Roadmap?` (approve the roadmap), `Push?` (the one owner-approved push), `Lane block?` (a BLOCKED lane) and `Conflict?` (an integration merge conflict). A bundle decision header is the bundle id followed by the lane's `header`, cut to 12 characters.
