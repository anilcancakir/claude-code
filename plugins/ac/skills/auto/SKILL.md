---
name: auto
description: "Carry a request through plan, execute and a final verification on a branch, without supervision, or take over the work in progress when the user leaves mid-session. Never pushes."
when_to_use: "Use when you can say up front what done means, or when the user is leaving and asks, in any language, to continue with ac:auto until done (\"I'm leaving, keep going until it's finished\"); not for open-ended audits or exploration."
argument-hint: "<request description>"
effort: high
---

# /ac:auto

Autonomous runner. It fixes what done means before any work happens, hands the work to the existing
`ac:plan` and `ac:execute` chain, and ends with a verdict written by a gate that did none of the work.

Request: $ARGUMENTS

## Standing rules

These hold for the whole run, including after a compaction. Everything below this block is procedure; these
are the bounds. They sit here because a re-attached skill keeps only its first 5,000 tokens after compaction
(https://code.claude.com/docs/en/skills.md) and this body is larger, so a rule further down is gone from
context on exactly the long runs that need it.

**Turn termination.** Your turn ends on exactly one of: the Phase 5 closing report, a terminal branch that
deleted `.ac/state/active-auto.json` first, or a one-line wait status while background workers you spawned still run (each task-notification starts your next turn; never wait with a `sleep` or polling loop). Nothing else ends it. While that marker exists,
`.ac/auto/<slug>/verdict.md` does not, and no background worker is running, the plugin's auto `Stop` guard blocks the turn from ending
(`${CLAUDE_PLUGIN_ROOT}/hooks/stop-guard-auto.sh`), and its block budget is 3 PER PHASE, so the gating
handoff always starts with a fresh three however many were spent earlier. Writing the verdict at Phase 4 is the only action that releases it for good. Never end a turn by
describing what you would do next, and never propose that the user open a fresh session to continue.

**Marker path.** `.ac/state/active-auto.json` is the single live-run record; the run directory is
`.ac/auto/<slug>/`. Create the run directory before or with the marker: the guard exits 0 when the directory is
missing (the run-directory check in `stop-guard-auto.sh`), so a marker written first leaves the guard silently
inert for the whole run.

**Questions reach the user; only plan-side ones continue on a timeout.** Every interview gate in `ac:plan`
Stage 3 and every BLOCKER in either chained skill reaches the user exactly as it would in a supervised run. You
never answer one ahead of the user and never infer the answer from the request prose. What happens when nobody
answers is set by the `On AFK timeout` column of each chained skill's `<auto_mode>` table, and only in this
session while it owns `.ac/state/active-auto.json`: a plan interview gate or another plan-side question continues
with its Recommended option once the question-timeout hook says so, recorded as "timed out, not user-approved";
an Oracle CRITICAL (plan 3.5c) continues at most once per run; an execute BLOCKER (2i dependency failed, 2j three
failures spanning two waves, 3c plan-spec issue, a failed checkpoint commit) waits for the user however long
that takes. No timed-out answer is ever written as `overrides[].accepted_by`: that field exists only when a real
user answer produced it. With `AC_AFK_TIMER` unset, or in a background session where Claude Code never arms the timer, this skill treats the timer as absent, and an adopted run locks its remaining plan
questions through Force-finalize instead (Phase A4). The promise this skill makes is that it does not stop for
anything else.

**Turn budget.** `turn_budget` in the run's `criteria.md` (default 40) is the turn count the user agreed to.
Increment `turns_used` on the marker each time you regain a control point, and compare there. On reaching the
budget without a verdict, ask the user through `AskUserQuestion` (header `Budget?`, which the question-timeout hook
always holds open, so this question waits on a timeout like an execute BLOCKER) whether to extend the budget, accept partial
progress and gate now, or abort. Do not pass the number silently.

**Failure budget.** `failure_budget` in `criteria.md` (default 0.2) is a fraction of total plan steps. Continue
while `failed_steps / total_steps` stays within it; hard-stop when it exceeds it, on the reasoning that a run
failing this often will not self-correct by continuing. A 0.2 budget tolerates one failing step in five, so
over a 15-step plan three failures (3/15 = 0.20) continue and the fourth (4/15 = 0.27) stops the run. A
hard-stop is a terminal branch: delete the marker first, then report which steps failed. Separately, execute's
2j detector counts three failures spanning two or more waves; after the user accepts one of those surfacings
and the run continues, record the current wave as the new span baseline so the detector re-arms and needs three
fresh failures rather than firing again on the same accumulated ones. The ratio above keeps its whole-run count;
only the span baseline resets.

**A stop needs a name.** Every phase that cannot proceed names which of three classes it hit: a fact you do not
have and cannot obtain, a decision only the user can make, or a gate you cannot pass. "I cannot verify this
properly in the remaining context" is none of them. Context pressure is not a stopping condition: auto-compaction
summarizes older turns and the run continues. When the procedure you need has been truncated away, re-invoke the
`ac:auto` skill to restore this body and read the marker's `note` and `phase` for where the run was.

**Nothing here is irreversible.** While the marker exists, the plugin's Bash guard denies twelve verbs including
`git push`, `git reset --hard` and `rm -rf`, and it does not exempt you
(`${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-bash-guard.sh`). An auto run never publishes: the branch it leaves is
the user's to review and push. Reach outcomes another way rather than around the guard.

**This body is a procedure, not a loop.** Nothing in it repeats. The wave loop belongs to `ac:execute`, and the
auto `Stop` guard is what re-enters the procedure when a turn tries to end before the gate has spoken.

**Output length.** Per-turn user-facing prose: at most 3 lines, plus the Phase 5 report. One heartbeat line per
phase transition. Every token you write stays in context and is re-read on every later turn; a file is read on
demand, a sentence in the chat is read hundreds of times.

<role>
You are the orchestrator of one unattended run. You decide whether the request is admissible, freeze its
completion criteria to disk, create the branch the work lands on, hand the work to `ac:plan --auto` (which
chains `ac:execute` itself), hand the judgment to `ac:auto-verifier`, and write down what that gate returned.
You do not implement the request yourself, you do not judge your own run, and you do not decide anything the
chained skills route to the user.
</role>

<scope>
Two files you write, both under `.ac/auto/<slug>/`: `criteria.md` (Phase 1 or Phase A3, frozen thereafter) and `verdict.md`
(Phase 4, verbatim from the gate). Plus the run marker at `.ac/state/active-auto.json` and one working branch.

Everything else on disk belongs to the chained skills: `.ac/plans/<slug>/` is `ac:plan`'s, source code is the
workers', `.ac/state/active-execution.json` is `ac:execute`'s. Do not write source code here, do not edit a plan
file, and do not touch either `stop-guard` script.
</scope>

<capabilities>
The base tools plus `AskUserQuestion`, which arrives directly rather than deferred. `Skill` invokes
`ac:plan` once, at Phase 2, or `ac:execute` once for the one adopted source that has no plan run to chain it
(Phase A1, source c). `Agent` spawns `ac:auto-verifier` once, at Phase 4. `Write` creates the two files in
`<scope>`; `Edit` patches the digest line into `criteria.md`. `Bash` is for the digest computation, the branch
creation, and read-only checks, all within the deny list above.

Its progress surface is the ones it drives: `criteria.md`, the plan file's checkboxes once `ac:plan` has
written one, and `verdict.md` at the end. A fourth surface over the same run would duplicate the report without
adding a fact.
</capabilities>

<constraints>
- The criteria are frozen before the chain starts and are never rewritten afterwards. A run that authors its own
  passing conditions after seeing what got built has no gate, only a mirror. An adopted execute run (Phase A1,
  source b) is the one case where they land mid-chain, which is why they are copied verbatim from a plan that
  predates the work rather than authored.
- The gate is read-only and is never the agent that did the work. It returns a body; you write the file.
- A verdict reporting an unmet criterion is a complete and correct ending. Write it as returned. Do not go back
  and try to make it pass, and do not edit the gate's words into a better result.
- Mutate a file with `Write` or `Edit`, never through `Bash`. Not `python3 -c`, not a `cat >` heredoc, not
  `sed -i`. `Bash` computes and reads; it does not write project state. One exception, because every terminal branch needs it: removing a file is `Bash: rm -f <path>`, which no `Edit` or `Write` call can do and which plain `rm` reaches without touching the guard's deny list.
- Do not invoke `ac:execute`. `ac:plan` Stage 6a chains it, so a second invocation runs the wave loop twice over
  the same plan. The one carve-out is Phase A1 source (c), a written plan nobody has executed: no `ac:plan` run
  exists to chain it, so there is no first wave loop for yours to duplicate. An execute run already in this
  session (source b) is never re-invoked.
- Do not run your own question round. The single round the user agreed to is `ac:plan` Stage 3.
- A user asking to stop, pause, or take back control outranks every rule here: delete the marker and stop. A
  user saying they are leaving and asking you to continue is the opposite request, the hand-off Phase A adopts.
</constraints>

<bootstrap>
Nothing to load; `AskUserQuestion` arrives directly on the main thread.

Read `${CLAUDE_SKILL_DIR}/references/criteria-schema.md` first. It is the authoritative definition of both
on-disk shapes and of the run directory's three files, and Phase 1 cannot be written correctly without it.

Begin at Phase A when the request is a hand-off of work already under way in this conversation, otherwise at
Phase 0.
</bootstrap>

## Phase A: Adopt in-flight work

A hand-off is the user leaving mid-session and asking you to carry the work already under way here to the end:
"I'm leaving, continue with ac:auto until done", or "ben bilgisayar basindan gidiyorum, ac:auto ile devam et,
bitirene kadar durma". It names no new task. A request that names a new task starts at Phase 0, whatever else
is in the conversation. Adopting rather than starting over matters because the work in context (an interview
half answered, a wave loop half run) is lost or duplicated by a fresh run.

### A0. Re-entry first

Run 1a0 before anything else. A live marker owned by this session is a re-entry, not a second adoption; one
owned by another session refuses, exactly as there.

### A1. Pick the source

Check (b) first, then (a), (c) and (d), and take the first match: a live execute run outranks a plan checkpoint
left over in the conversation, which would otherwise chain `ac:plan --auto` over it. The source fixes where the
criteria come from, the `adopted_from` value the schema defines, how the work continues, and the branch.

| Source | Evidence | `adopted_from` | Criteria from | Continue with | Branch |
|---|---|---|---|---|---|
| (a) plan interview | `.ac/plans/<slug>/checkpoint.json` of the `ac:plan` run in this conversation | `plan-interview` | the checkpoint's `topic` and `locked_decisions` | `Skill: skill "ac:plan", args "--auto <checkpoint slug>"` | `auto/<slug>` |
| (b) execute run | `.ac/state/active-execution.json` whose `session_id` equals `${CLAUDE_SESSION_ID}` | `execute` | the plan file, A2 | the run already in context; invoke nothing | current |
| (c) written plan | `.ac/plans/<slug>/plan.md` with an unchecked step, no `report.md`, no `active-execution.json` | `plan` | the plan file, A2 | `Skill: skill "ac:execute", args "<slug> --auto"` | `auto/<slug>` |
| (d) ad-hoc | none of the above | `adhoc` | the conversation goal, through 0a and 0b | Phase 2 with that goal as the request | `auto/<slug>` |

- **(a)** Pass the checkpoint slug verbatim, never its topic. `ac:plan` 0b re-derives the slug from its argument,
  and a topic re-derives one that need not match, so the resume misses the checkpoint and the interview starts
  over (measured 2026-10-17: a topic and the slug its checkpoint sat under differed in the last word). The
  plan's resume restores `topic` as the request. These criteria are sound: the topic and locked decisions
  precede the work.
- **(b)** Never invoke `ac:execute`. Its 1e writes `active-execution.json` without an existence check and keeps
  its failure history in context only, so a second invocation overwrites the marker and restarts the wave loop
  with that history reset. Freeze the criteria and write the marker (A3), then let the run continue: it keeps
  `AUTO_MODE` true once this session's `active-auto.json` appears, and its final commit goes `--no-push` because
  that file exists (execute 4a). When it reaches its own terminal state the turn tries to end, the auto `Stop`
  guard blocks it, and the same-session re-entry at 1a0 takes you to the gate. An `active-execution.json` owned
  by another session is that session's run: refuse, naming its slug, as 1a0 does for a foreign marker.
- **(c)** The carve-out in `<constraints>` covers this one invocation. Phase 2's failure-budget and BLOCKER rules
  apply to the run it starts exactly as to a chained one.
- **(d)** When the goal's work is already complete by the time the hand-off arrives, there is nothing to adopt:
  end on a closing report with no run directory, no marker and no branch (measured 2026-10-17: a finished
  two-file task still went through a full plan and execute chain). Otherwise apply 0a and 0b to the conversation
  goal written as one request, then 0c. Admissible: continue at A3.
  Inadmissible: no refusal, because the user has left and asked for the work to be finished. Finish the task
  under the working rules with no run directory, no marker and no branch, and end on a closing report of what
  is done and what is still open.

### A2. Criteria from a plan file (sources b and c)

Copy every `### Definition of Done` item and every step's `Done when` command verbatim, one criterion each,
carrying `anchor: "<plan path>:<line>"`. A shell command becomes `verification: command` with the exit code its
wording states (a "prints nothing" `rg` gate passes on exit 1); prose becomes `verification: judgment`. Do not
merge, reword, narrow or drop one. Under (b) part of the work already exists, and copied text with its anchors
is what lets a reader confirm each criterion predates it.

### A3. Freeze, mark, branch

Phase 1 in its usual order, so every adopted run has its run directory and criteria before its marker:

1. Slug (1a), from the source's plan slug, or from the goal under (d).
2. Run directory, then `criteria.md` with `adopted_from` set, then the digest (1b). The guard exits 0 without
   the directory (the run-directory check in `stop-guard-auto.sh`).
3. Marker (1c), `phase: "planning"` for (a) and (d), `"executing"` for (b) and (c).
4. Branch (1d) for (a), (c) and (d). Under (b) stay on the current branch: the run's earlier wave commits are
   already there, and a switch mid-loop would split one plan's history across two branches.

### A4. Timer (sources a and d)

Both still have `ac:plan` Stage 3 questions ahead. Check `Bash: printenv AC_AFK_TIMER CLAUDE_JOB_DIR`; the launch
wrapper exports `AC_AFK_TIMER` alongside `CLAUDE_AFK_TIMEOUT_MS`, so it is the evidence that a question can time out
at all. A background session (`/background`, `claude --bg`, a daemon-hosted session, which is what sets
`CLAUDE_JOB_DIR`) counts as Unset whatever `AC_AFK_TIMER` says: Claude Code 2.1.302 never arms the question timer
there (`!$t()` in its timer condition, `$t` being the session kind `bg`), so a question would wait forever.

- **Set**: questions are still asked, and the user may answer one if they pass by. When one times out, the
  question-timeout hook says whether to continue, under the Standing rule on questions.
- **Unset**: an asked question would wait for a user who has left. Lock the remaining plan questions through
  `ac:plan` 3d Force-finalize: every unresolved node takes its Recommended option into the plan's
  `## Risks Accepted`, each recorded "no timer, not user-approved". Put that in the marker's `note` so it
  survives a compaction. Execute BLOCKERs still wait.

### A5. Heartbeat, then continue

One line: the source, the slug, the branch, both budgets, and for (a) and (d) the timer state. With the timer
set, name what lets it run: an unfocused or detached terminal; a focused window keeps every question waiting.
Then continue as the A1 table says.

## Phase 0: Admission

### 0a. Enumerate the criteria

Read the request and draft, in full, the `must_haves` and `criteria` blocks the schema defines. Nothing is on
disk yet, so this costs one turn and can be abandoned for free.

For each criterion, name either the shell command that checks it plus the exit code that counts as a pass, or
the artifact a judgment read would open. Those are the only two verification tiers; there is no third.

### 0b. The refusal test

If any part of "done" cannot be stated before the work exists, the request is not admissible and this run
refuses it. Typical shapes: "clean up the codebase", "see what is wrong with the auth layer", "make it faster"
with no number. What makes them inadmissible is not vagueness of wording but that their criteria are an output
of the work rather than an input to it, which leaves the gate nothing to judge against.

Refuse in at most 5 lines: name which criteria could not be enumerated, and name the alternative inline, an
audit run that produces criteria and stops, then a separate run against frozen criteria. Do not write the
marker, do not create the run directory, do not create a branch, and do not improvise the audit run here: v1
carries no open-ended audit support, and starting one under this skill produces an unattended run with no
terminus.

### 0c. Budgets

`turn_budget` defaults to 40 and `failure_budget` to 0.2. An explicit number in the request overrides either.
Say both values in the one-line admission heartbeat, since they are the bounds the user is agreeing to.

## Phase 1: Freeze the run

### 1a0. Re-entry check, before anything else

Read `.ac/state/active-auto.json` if it exists. Three outcomes, and none of them is "carry on and write a new
marker": the marker is a single global slot per repository, so minting a second run over a live one leaves the
first with no guards, no verdict, and nothing that notices.

- **Absent**: no run is live. Continue to 1a.
- **Present and its `session_id` equals `${CLAUDE_SESSION_ID}`**: this is a re-entry, not a new run. Two places tell you to
  re-invoke this skill mid-run, the Standing rules above and the Stop guard's latch note, and both land here.
  Skip Phases 0 and 1 entirely and resume at the phase the marker names, reading its `note` for where the run
  was. Do not re-derive a slug and do not touch `criteria.md`; the contract is already frozen. `executing` never
  means invoking anything: while this session's `.ac/state/active-execution.json` exists the run is still going
  in context, so carry on with it; once it is gone the chain has ended, so refresh the marker to `gating` and go
  to Phase 3. This is how an adopted execute run (Phase A1, source b) reaches the gate.
- **Present and owned by another session**: refuse. Say which slug holds the marker and that the operator can
  delete `.ac/state/active-auto.json` if that run is genuinely abandoned. Do not delete it yourself; you cannot
  tell an abandoned run from one running in another window.

### 1a. Slug

Kebab-case, at most 6 words, derived from the request. If `.ac/auto/<slug>/` exists, append `-2`, then `-3`,
until the name is free. Preserving a previous run beats overwriting it.

### 1b. Run directory and criteria file

Create `.ac/auto/<slug>/` first, then `Write` the Phase 0 enumeration to `criteria.md` in the schema's exact
shape and `criteria_sha256: "pending"`. The frontmatter carries no `status` and no `gaps`: the digest covers
that whole block, so a field something was meant to fill later would either break the digest or sit unchanged
forever, and the run's outcome belongs in `verdict.md`. Overrides go below the delimiter, outside the digest,
because a human waiver is a legitimate later edit and must not read as tampering. The file lands here,
before the chain runs, because the session that writes the criteria is the session that then does the work; a
criteria file authored afterwards would be written with full knowledge of what got built, which is the exact
failure the digest exists to catch. The directory comes first because the
Stop guard treats a missing run directory as a malformed run and exits 0, so a marker that lands before the
directory leaves the run unguarded from beginning to end.

No `python3` on this machine is a gate you cannot pass: delete the marker, say so, and stop, because a digest
you improvise is one the gate cannot reproduce and it would refuse every run.

Then compute the digest over the frontmatter minus its own digest line, which is the span the schema defines,
and patch that one line with `Edit`:

```bash
python3 - .ac/auto/<slug>/criteria.md <<'PY'
import hashlib, sys
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
start = lines.index('---')
end = lines.index('---', start + 1)
covered = [l for l in lines[start + 1:end] if not l.startswith('criteria_sha256:')]
print(hashlib.sha256('\n'.join(covered).encode('utf-8')).hexdigest())
PY
```

Use this recipe rather than an equivalent you reason out. It is byte-identical to the one `ac:auto-verifier`
recomputes with, and the detail two implementations disagree on is whether a trailing newline follows the last
frontmatter line. A writer and a reader that disagree there fail every file.

Prose below the closing delimiter is not covered by the digest and is free to grow. Frontmatter is not: from
here on, that block is the contract.

### 1c. Marker

`Write` `.ac/state/active-auto.json` with the fields the schema names: `slug`, `session_id` (write exactly `${CLAUDE_SESSION_ID}`,
which Claude Code substitutes with this session's id; it is what scopes both guards to this run), `started_at` (the
output of `date -u +%Y-%m-%dT%H:%M:%SZ`, written once and never refreshed),
`turns_used: 0`, `phase`, `note`. This body owns the `phase` value set and it holds three values: `planning`,
`executing`, `gating`. Write `planning` here.

Refresh `turns_used`, `phase` and `note` at every control point you regain. The chain in Phase 2 does not hand
one back on its own, so in practice the refreshes happen at phase boundaries and after a BLOCKER answer.

### 1d. Working branch

```
Bash: git switch -c auto/<slug>
```

An unattended run's commits stay off whatever branch the user left checked out; the guard denies `git push`, so
review and publishing stay with the user afterwards. Uncommitted changes follow the switch, which is the
intended behaviour: do not stash them, and do not commit them as part of this run. If the branch name is taken,
append `-2` as at 1a. If the switch fails, that is a gate you cannot pass: delete the marker and report.

## Phase 2: Plan and execute

```
Skill: skill "ac:plan", args "--auto <request>"
```

Three things about that call decide this phase's shape:

- Its Stage 3 interview is this run's single question round. `ac:plan`'s `<auto_mode>` table classifies
  3a, 3b.1, 3b.2 and 3c as interview gates that surface whatever the mode, deliberately, because they are
  preference content rather than process flow. That is why this body runs no question round of its own. They
  still surface; only on an AFK timeout in this session do they continue, as the Standing rule on questions and
  that table's `On AFK timeout` column say.
- Its Stage 6a chains `ac:execute` with `<slug> --auto` in the same turn. Do not invoke `ac:execute` yourself.
- Control does not come back until the chain reaches a terminal state or a BLOCKER surfaces.

While the chain runs, the rules that are yours rather than its: no execute BLOCKER is answered for the user and
only plan-side questions continue on a timeout, the failure budget
is measured against the plan's step count as failures accumulate, and the 2j span baseline resets after each
acceptance. Exceeding the failure budget is a hard stop before the gate, and a hard stop deletes the marker
first; leaving it behind blocks the session at a guard that no longer has a run to protect.

When control returns, refresh the marker (`phase: "gating"`, `turns_used`, a one-line `note`).

## Phase 3: Reconcile, do not rewrite

Recompute the digest with the command at 1b and compare it to the `criteria_sha256` line. A mismatch means the
contract changed after it was fixed: delete the marker, name the mismatch, and hand the run to the user rather
than gating against a file whose provenance is now unknown.

If a decision locked in the Stage 3 interview diverges from a frozen criterion, append the divergence as prose
below the closing frontmatter delimiter, one line naming the criterion id and what changed. That region is
outside the digest by design, so the note costs nothing and the gate can weigh it. Do not edit the frontmatter,
do not set `status`, and do not fill `gaps` or `overrides`: those three are the gate's to write, and a criterion
adjusted after the work is exactly what the digest exists to make visible.

## Phase 4: Gate

```
Agent({
  subagent_type: "ac:auto-verifier",
  description: "Auto-run verdict",
  prompt: "Criteria: .ac/auto/<slug>/criteria.md
Schema: ${CLAUDE_SKILL_DIR}/references/criteria-schema.md"
})
```

Two paths and nothing else. The fresh context is the whole point of the gate; adding your account of how the
run went replaces the evidence it was supposed to gather with your summary of it.

The schema path is passed rather than left for the gate to construct because the gate has no skill directory of
its own: the skill-directory variable resolves only in the body of the skill that spawns it, and this is that
body. Confirm both paths in the prompt are absolute before the spawn; the gate has no way to resolve one that is not.

`Write` the returned body verbatim to `.ac/auto/<slug>/verdict.md`. This write is the only thing that releases
the Stop guard, and the guard never opens the file, so a verdict of `gaps_found` ends the run exactly as
`passed` does.

If the gate returns nothing usable, spawn it once more. If the second attempt also returns nothing, write a
verdict yourself carrying `status: human_needed`, an empty evidence table, and one line naming what the gate
did. That is a record of a missing judgment, not a judgment: never write `passed` for your own run.

## Phase 5: Close

Delete both `.ac/state/active-auto.json` and `.ac/auto/<slug>/stop-guard-auto.json`. The second is the Stop
guard's own block counter rather than a result, and it lives beside the run so that closing the run closes its
budget with it; the run directory is left holding `criteria.md` and `verdict.md`, which are the two things a
later reader needs.

Report in at most 8 lines: slug, branch name, the verdict's `status`, criteria passed against total, each gap in
one line, and the path to `verdict.md`. A `proposed_overrides` entry in that verdict is a suggestion addressed to
the user and stays one: it becomes an override only when the user answers, and only their answer fills
`accepted_by`. Close by naming what is left to the user: reviewing the branch and
pushing it, because this run did neither. If the user keeps a goal tracker, `/goal` is theirs to type; it is a
local CLI command and the Skill tool rejects local-type commands, so never invoke it.

## Terminal branches

Five endings, and each deletes `.ac/state/active-auto.json` and `.ac/auto/<slug>/stop-guard-auto.json` before it stops. Deleting only the marker leaves a counter whose budget the next run in this directory would inherit:

| Ending | Where | Marker |
|---|---|---|
| Verdict written | Phase 4, then Phase 5 closes | deleted at Phase 5 |
| Failure budget exceeded | Phase 2 | delete, then report the failed steps |
| Turn budget reached and the user picked abort | any phase | delete, then report what landed |
| A chained BLOCKER the user resolved as stop or pause | Phase 2, inside `ac:plan` or `ac:execute` | delete, then report which BLOCKER and what the user chose |
| An error before the gate (branch, digest mismatch, chain aborted) | any phase | delete, then name the stop class |

A Phase 0 refusal and an inadmissible ad-hoc hand-off (Phase A1, source d) are not in this table: nothing was
written, so there is nothing to clean up.

<reminders>
- Criteria are frozen before the chain and reconciled, never rewritten, after it.
- `ac:plan --auto` chains `ac:execute` itself; invoking execute here runs the work twice.
- The gate returns a body and you write the file, so the component judging the run holds no tool that can change
  what it judged.
- Only plan interview gates and plan-side questions continue on an AFK timeout, recorded as not user-approved and
  never as `accepted_by`; execute BLOCKERs wait for the user.
- An adopted execute run is never re-invoked; it reaches the gate through the same-session re-entry.
- Every ending deletes the marker first.
</reminders>
