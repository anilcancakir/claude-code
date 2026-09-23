# Auto-Run Criteria and Marker Schema

Two on-disk shapes back `/ac:auto`. The criteria file states, before any work starts, what "done" means for this request and how each item is checked. The state marker names which run is live, the way `.ac/state/active-execution.json` does for `/ac:execute` (`${CLAUDE_PLUGIN_ROOT}/skills/execute/references/execution-state.md:17-40`). A fresh agent should be able to write a valid criteria file from this document alone.

## Why two verification tiers only

A must-have is either checked by running something with a known exit code, or checked by an agent reading the result and judging it. There is no third tier and no severity or enforcement-level field: adding one invites a criterion that is "checked but not enforced", which is exactly the cosmetic-gate failure this design exists to avoid. Every criterion is `verification: command` or `verification: judgment`, nothing else.

## `criteria.md`

Path: `.ac/auto/<slug>/criteria.md`. One file per auto run, written before the plan/execute chain starts and read by the read-only gate at the end.

### Shape

```markdown
---
turn_budget: 40
failure_budget: 0.2
criteria_sha256: "<sha256 hex, see below>"
must_haves:
  truths:
    - "A user can request a password reset and receive an email"
  artifacts:
    - path: "app/Http/Controllers/PasswordResetController.php"
      provides: "the reset request and confirm endpoints"
  key_links:
    - from: "app/Http/Controllers/PasswordResetController.php"
      to: "app/Mail/PasswordResetMail.php"
      via: "controller dispatches the mailable on a valid request"
  prohibitions:
    - statement: "MUST NOT log the raw reset token"
      status: "unresolved"
      verification: "judgment"
criteria:
  - id: "c1"
    statement: "php artisan test --filter=PasswordResetTest passes"
    verification: "command"
    command: "php artisan test --filter=PasswordResetTest"
    expected_exit_code: 0
  - id: "c2"
    statement: "the reset email renders the user's first name, not their email address"
    verification: "judgment"
---

Free-form notes on the request go here, below the closing frontmatter delimiter. Everything above
the delimiter is the frozen contract and is covered by `criteria_sha256`; everything below is not.
Editing these notes does not invalidate the digest. Editing a criterion does.

## Overrides

A human waiver of one criterion. Empty until a person adds one, and it lives HERE, below the
delimiter, on purpose: an override is a legitimate later edit by a human, and a legitimate later
edit must not look like tampering. Putting it in the frozen block would make every waiver break
the digest and read as a rewritten contract.

```yaml
- criterion_id: "c2"
  reason: "the endpoint is behind a feature flag that is off in this release"
  accepted_by: "anilcan"
  accepted_at: "2026-09-03T18:04:00Z"
```
```

### Field reference

- `must_haves`: the four sub-fields adapted from the `must_haves` block in open-gsd/gsd-core's `agents/gsd-verifier.md`, unchanged in field names and meaning:
  - `truths`: observable, testable behaviors the finished request must exhibit. Plain sentences, not commands.
  - `artifacts`: `{path, provides}` pairs. `path` is the file the request must produce or change; `provides` is one sentence on what that file is for.
  - `key_links`: `{from, to, via}` triples naming a connection between two artifacts that must actually exist (a caller wired to a callee, not two files that happen to sit near each other). `via` states how, in prose.
  - `prohibitions`: `{statement, status, verification}` triples, the must-NOT sibling of `truths`. `statement` is the negative claim ("MUST NOT ..."). `status` is `resolved` or `unresolved`; `unresolved` means the run has not yet demonstrated the prohibition holds. `verification` is the same two-value field defined below, scoped to this one prohibition.
- `criteria`: the enumerable list of completion criteria proper, distinct from `must_haves` (which states what must be true or exist; `criteria` states what must be checked to call the run done). Each entry:
  - `id`: short stable string. The gate keys its verdict rows on it, and an override names it.
  - `statement`: one sentence, human-readable, naming the observable outcome.
  - `verification`: `command` or `judgment`. No third value.
  - `command`: required when `verification: command`, absent when `verification: judgment`. The literal shell command the gate runs.
  - `expected_exit_code`: required when `verification: command`. The exit code that counts as a pass; the gate treats any other code as a fail, not a crash.
  - A `judgment`-tier criterion carries no `command` and no `expected_exit_code`. The gate reads the artifact or the transcript and states pass or fail with a one-line reason; it never invents a command for a criterion that named none.
- `turn_budget`: an integer turn count. When the run's turn counter reaches this number without reaching a verdict, the run stops and asks the user how to proceed (extend the budget, accept partial progress, abort) rather than continuing silently past the number the user agreed to at the start.
- `failure_budget`: a fraction between 0 and 1, applied to total step count across the run (not to `criteria` count). When the proportion of failed steps exceeds this fraction, the run hard-stops before reaching the gate, on the reasoning that a run already failing this often will not self-correct by continuing; a `0.2` value tolerates one failing step in five before it stops.
- `criteria_sha256`: the sha256 hex digest of the frontmatter, taken over every line between the two `---` delimiters EXCEPT the `criteria_sha256` line itself, joined with newlines and hashed as UTF-8. Dropping that one line is what resolves the circularity of digesting a block that contains its own digest; it is ordinary checksum-line practice, the same trick a checksum embedded in the file it describes has always used.

  The digest deliberately covers the frontmatter and not the prose body. The criteria are the thing worth protecting, and they live in the frontmatter: a digest taken over the body after the delimiter would detect an edit to the notes while leaving every `command`, `expected_exit_code` and `prohibition` free to change unnoticed, which is the exact inversion this field exists to prevent. The body is unprotected on purpose, because prose drifting has no consequence the gate acts on.

  The gate recomputes this digest before it reads a single criterion and refuses to proceed on a mismatch. Treat it as tamper evidence, not as a trust signal: nothing here is cryptographically signed, so a mismatch means "the contract changed after it was fixed", and a match means only "it did not", never "this file is authentic". Read the guarantee narrowly. The session that writes the criteria is the session that then does the work and it holds the recipe, so a deliberate rewrite can update the digest too. What this catches is the UNRECORDED change: drift, a stray write, a rewrite that forgot the hash. Worth having, and not the same as a guarantee.

- No `status` and no `gaps` field. The run's outcome lives in `verdict.md`, written once at the end from what the gate returns, and this file never learns it. That is not an omission: `criteria_sha256` covers this whole frontmatter, so a field the gate was expected to fill would either break the digest it just verified or sit at its write-time value forever. The contract is frozen by construction, and a frozen file cannot also be a status board.
- Overrides live BELOW the closing delimiter, outside the digest, in the `## Overrides` section shown above. A waiver is a human edit made after the contract was fixed, which is exactly the shape the digest is built to flag, so it is kept out of the digested span rather than being allowed to look like tampering. The gate reads them from there. It may propose one; only a person may write `accepted_by`.

### Invariants

- `started_at` on the state marker (below) is written once and never refreshed, for the same reason `plugins/ac/skills/execute/references/execution-state.md:34` gives for `active-execution.json`: it is the age bound a hook uses to treat a stale marker as abandoned, and it is the key a block counter uses to hand a run a fresh budget. A criteria file carries no `started_at` of its own; the marker is the single source for it.
- `overrides[].accepted_by` is writable only from a real user answer, never by a model. A gate or a worker that finds a failing criterion may propose an override (statement plus reason), the same split open-gsd/gsd-core draws in its `verification-overrides` reference, where the verifier suggests an override and a person accepts it, but the entry does not exist in `overrides[]` until the user has answered an explicit question and the answer is recorded verbatim as `accepted_by`. No agent fills that field with its own name, a placeholder, or an inferred identity.

## `.ac/state/active-auto.json`

Path: `.ac/state/active-auto.json`. Written once at the start of an `/ac:auto` run, refreshed on a narrow subset of fields, and removed on every terminal branch, mirroring the lifecycle discipline at `plugins/ac/skills/execute/references/execution-state.md:40`.

### Shape

```json
{
  "slug": "<auto-run slug>",
  "session_id": "<the session id the skill body gives you>",
  "started_at": "<output of date -u +%Y-%m-%dT%H:%M:%SZ>",
  "turns_used": 0,
  "phase": "planning",
  "note": "<one-line resume hint>"
}
```

### Field reference

- `slug`: the auto-run slug, matching the `<slug>` segment of `.ac/auto/<slug>/criteria.md`. Names which run holds the scope lock and which criteria file a hook or a resumed session should read.
- `session_id`: the current session id, written once and matched by any guard that scopes its blocking behaviour to the session that started this run, the same role `session_id` plays in `active-execution.json`.
- `started_at`: written once here and never refreshed. See the invariant above.
- `turns_used`: an integer counter, incremented as the run progresses. Compared against `criteria.md`'s `turn_budget` to decide when to stop and ask.
- `phase`: the run's current stage in the plan/execute/gate chain (for example `planning`, `executing`, `gating`). Plain string, not an enum in this document; the skill body that drives the state machine owns the exact value set.
- `note`: a one-line resume hint in plain prose, refreshed as the run progresses, read back after a compaction or a restart, matching the role `note` plays in `active-execution.json`.

### Lifecycle

Written once at run start with `slug`, `session_id`, `started_at` fixed for the run's lifetime. `turns_used`, `phase`, and `note` refresh as the run progresses. Removed on every terminal branch: a verdict from the gate, a hard stop from `failure_budget`, a turn-budget stop the user resolves as abort, or an error that aborts the run before the gate. The marker must never survive a halt with a stale state, for the same reason the execute-side marker must not: a guard reading its presence as "this run is unfinished" would block turn ends past the point the run actually ended.

## The rest of the run directory

`.ac/auto/<slug>/` holds three files, not one. The other two are named here because a hook already keys on
them and a reader of this document would otherwise not know they exist.

- `criteria.md`: the contract above, written before any work starts.
- `verdict.md`: written once, at the end, by the `/ac:auto` skill from the body its read-only gate returns. Its
  presence is the entire predicate of `plugins/ac/hooks/stop-guard-auto.sh:121-122`, which blocks a turn from
  ending while the marker exists and this file does not, and never opens it. Contents are the gate's
  `status` (`passed`, `gaps_found` or `human_needed`), its `gaps[]`, and a per-criterion evidence table.
  A verdict reporting an unmet criterion is a complete ending; the guard does not distinguish.
- `stop-guard-auto.json`: the block counter that same hook keeps, `{run, blocks, spent}` keyed on the marker's
  `started_at`. It lives beside the run rather than in `.ac/state/` so deleting a run directory takes its
  budget with it. Nothing else reads it.

The gate writes none of these. It returns a body and the skill writes it, so that the component judging the
run holds no tool that can change what it judged.

## Worked example (for QA)

A three-criterion `criteria` block, one `command` and two `judgment`, using only fields defined above:

```yaml
criteria:
  - id: "c1"
    statement: "the test suite for the new endpoint passes"
    verification: "command"
    command: "bun test tests/reset.test.ts"
    expected_exit_code: 0
  - id: "c2"
    statement: "the error message shown on an expired token is understandable to a non-technical user"
    verification: "judgment"
  - id: "c3"
    statement: "the endpoint follows the project's existing controller pattern"
    verification: "judgment"
```
