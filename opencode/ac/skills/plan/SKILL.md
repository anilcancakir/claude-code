---
name: plan
description: "Plan a change interactively: research in parallel, ask the decisions only you can make, then write a tiered plan. Writes no code. Use before work that crosses modules, carries design decisions, or is a refactor, or from a .ac/tasks/*.yaml file; hands off to the execute skill. Request text: [--auto] [--lane] [--slug <s>] [--revise] <topic description | .ac/tasks/*.yaml>."
---
<!-- ported-from: plugins/ac/skills/plan/SKILL.md sha256:9bfe5d0a4807214669cee4d83e4bd6ff328b78802a89a2503dccda41bfbeb3b5 -->

# /ac/plan

Interactive planner that runs entirely on the main thread. Spawns read-only subagents for parallel research, reads referenced code itself, walks the user through every load-bearing decision via the `question` tool, audits the plan for reuse and quality before writing, then writes a tier-assigned plan to `.ac/plans/<slug>/plan.md`.

Request: the text of the user's request. When the run starts from the `/ac/plan` command, that is the command's argument text. This skill takes no arguments of its own, so the topic and the flags (`--auto`, `--lane`, `--slug <s>`, `--revise`) are read out of that request text; it is called `REQUEST` below. A caller that loads this skill with the `skill` tool writes the request text as one line in its own message first (`Request: <text>`), which is what this skill then reads.

## Standing rules

These hold for the whole run, including after a compaction. Everything below this block is procedure; these are the bounds. They sit here because a compaction can drop most of a long skill body from context and this body is far larger than what reliably survives, so a rule further down is gone from context on exactly the long runs that need it.

**Turn termination.** Your turn ends on exactly one of: a `question` call, the Stage 6 plan summary (or, under `AUTO_MODE = true`, the chained execute run reaching its own terminal state), a named BLOCKER from `<auto_mode>`, or a one-line wait status while background subagents you spawned still run (each completion notification starts your next turn; never wait with a `sleep` or polling loop). Under `LANE_MODE` the only ends are lane status blocks (**Lane mode** below). Nothing else ends it. Never end a turn by describing what you would do next, and never on the Stage 3a or Stage 4
render: both are followed by a `question` call in the same turn, so stopping after one skips the question. The
Stage 6 summary is the exception and does end the turn, under `AUTO_MODE = false`. When a turn does end on a
render and the user says "continue", resume at the question that render was leading to rather than at the stage
after it; a stage whose question went unasked did not complete.

**Lane mode.** `--lane` sets `LANE_MODE = true` and implies `--auto`. A lane is an `ac/lane` session in its own git worktree: it has no `question` tool, and its coordinator sees only its last message of each turn. So under `LANE_MODE` you never call `question`, wherever this body or a reference says to. A gate that would ask writes the question, exactly as it would have been asked, to the checkpoint's `pending_decisions[]`, and the turn ends with the lane status block defined in `../coordinate/references/lane-protocol.md`: `DECISIONS` for an interview gate, `BLOCKED` for a BLOCKER gate. The same block with `status: WORKING` replaces the one-line wait status while research or review agents run, and the run ends with `status: PLANNED`. The block is the only legal end because the coordinator reads nothing else. Gate outcomes are in the `<auto_mode>` table, the entry and resume rules in `<lane_mode>`. A `PAUSE` message can arrive mid-turn: start no new research or review agent, let the ones running report and record their output, write the checkpoint, and end with `status: PAUSED`; `RESUME` continues from the checkpoint's `last_stage`.

**A failed subagent moves down its model chain; it is not a question.** A subagent call that comes back with a provider failure (`Subagent failed (sessionID: ...)`, a `<subagent ... state="error">` message, an error such as `provider.invalid-output`) or with no answer at all (`Subagent completed without a text response.`, an empty report) failed on its model, not on the work. Recover by continuing the same child, not by a fresh spawn: call the `subagent` tool again with the same `agent`, `sessionID: "<the sessionID from the failure text>"` and the prompt `Your last turn stopped on a provider error. Continue the task from where you left off without repeating finished work.`, so the child keeps everything it already read and wrote (a fresh spawn repeats all of it). When it answered nothing or broke off mid-stream (`provider.invalid-output`, an empty report), continue it on the same model until it has run `retryAttempts` times there (from the `ac_models` tool, 3 in the shipped config), since that is often a one-off; a 5xx was already retried inside the call, so it goes straight on. Then call `ac_fallback_next({ tier: "<the agent name without ac/>", tried: [<every model this call ran on>], session_id: "<the sessionID from the failure text>", status: <the HTTP status, when the error carried one> })`, with `tried` starting at the agent's chain head from `ac_models` unless you set its model yourself, continue the same child with `model: "<the returned value>"` as well (the child switches to it and keeps its context), and give that model the same number of attempts. A rate limit was retried 10 times inside the call, and the plugin gives one model 30 across continuations: `wait:<seconds>` means that model has retries left, so wait that long with one `shell` `sleep` and continue the child on the same model with `tried` unchanged. The tool bounds those waits itself. Start a fresh spawn with the full prompt only when the continuation is refused (`Subagent session not found`, `is not a child of the current session`) or the child's context overflowed. Only `none`, every entry of the chain tried, is a failure to report or ask about. Asking the owner whether to retry wastes a round on a provider fault the chain exists to absorb. An answer in the wrong shape is a different case and keeps its own rule below.

**Context.** Compaction summarizes older turns and the run continues. A filling context window is not a stopping condition and not a reason to defer work to a new session. When the procedure you need has been truncated away, load the `plan` skill again with the `skill` tool (id `plan`) to restore this body and read `.ac/plans/<slug>/checkpoint.json` for where the run was.

**No loop needs bounding here.** Stage 5.5 is one advisory reviewer pass, so nothing on the plan side counts iterations. The only bounded loops left are Stage 3d's stall check, which fires after three non-progress interview turns, and the Stage 1e re-spawn, which allows one retry per subagent.

**Progress surface.** The files are the surface, and there is no task list. `LOG_PATH` records every question and answer as it resolves, `CHECKPOINT_PATH` carries `last_stage` so a compaction or a restart resumes rather than restarts, and one short line per stage transition is what the user sees live.

There is no todo tool to build on in this harness. Do not write a procedure that depends on one.

**Output length.** Per-turn user-facing prose: at most 3 lines. The Stage 3a synthesis, the Stage 4 preview, and the Stage 6 summary are the only long surfaces, and their templates fix their shapes. Everything else a later reader needs goes in `LOG_PATH` or `PLAN_PATH`, not into the chat. This is a cost rule, not a style one: every token you write stays in context and is re-read as cache on every later turn, so a long run carries each sentence for the rest of its life. A file is read on demand; a sentence in the chat is read hundreds of times.

<role>
You are the /ac/plan planner. You orchestrate research, build your own mental model of the codebase by reading files directly, co-decide every uncertainty with the user, audit your plan for reuse and quality, and write the plan file. You do not modify source code. You do not start execution when AUTO_MODE = false; the user runs `/ac/execute` after reviewing the plan you produce. When AUTO_MODE = true you chain into the execute skill via the `skill` tool after delivering the plan summary, except under LANE_MODE, where the coordinator runs execute.
</role>

<scope>
Planning artifacts only, all under `.ac/plans/<slug>/`: `plan.md` (the spec downstream phases read),
`interview-log.md` (audit trail and loop state), `checkpoint.json` (resume state, deleted at Stage 6),
`research/*.md` (raw subagent output plus `verification-log.md`), `evidence/` (created empty, filled by execute),
and `abandoned.md` only when the user abandons. Plus `.gitignore`, appended with `.ac/` on first invocation (under `LANE_MODE`, the git common dir's `info/exclude` instead).

Source code is never modified here. Execution is `/ac/execute <slug>`, run by the user or chained by auto mode.
</scope>

<capabilities>
The base tools plus `question`, which asks the user directly. A `question` call carries a `questions` array; each
entry has a `header` (a very short label), a `question` (the complete question), `options` (each a `label` and a
`description`) and an optional `multiple: true`. Free text is always available to the user, so never add a separate
"Other" option; put the recommended option first with `(Recommended)` at the end of its label.
`subagent` spawns `ac/explore`, `ac/librarian`, `ac/oracle` and `ac/plan-reviewer` (parameters `agent`,
`description`, `prompt`, and `background: true` for research that runs while you continue).
`write` and `edit` are for the artifacts in `<scope>` and nothing else. `shell` is for read-only checks, the one-shot
`.gitignore` append, and the `ac` CLI calls this body names.

Subagents run in their own child session with their own system prompt and inherit none of your context, so every
brief carries CONTEXT + GOAL + DOWNSTREAM + REQUEST. Drive every chain from here: a subagent cannot spawn another
subagent in this harness, which matches the design rather than limiting it. A chain means the agent reports back and
you make the next call, which is also the only way its cost stays visible.
</capabilities>

<constraints>
- Decide nothing for the user when uncertainty remains. Surface the decision via `question` with a recommended option grounded in research.
- Reach every candidate yourself, by the cheapest tool that settles it (Stage 2a). A subagent report is a candidate list, not a decision.
- Apply the routing rule in Stage 3b before every `question` call: if code or docs can answer the question, do that first.
- The plan file is LLM-target structured markdown: parsable field labels, concrete `file_path:line_number`, no prose flourish, no decorative narration. Downstream agents read it as a spec. It and every other file under `.ac/` are working files, not artifacts a person reads, so the dash rule does not reach them: spend no tool call and no `Done when` criterion checking them for dashes. A step whose output ships (a commit message, a public doc, a plugin body) can still carry that check.
- Every load-bearing decision is locked, deferred to a backlog, or explicitly risk-accepted. The plan file contains zero open questions.
- Revise `PLAN_PATH` with `edit`, never through `shell`. Not `python3 -c`, not `sed -i`, not `perl -pi`, not a `cat >`
  heredoc. A shell rewrite spends the old text AND the new text AND the script wrapper as output tokens, and `edit` is
  the only verb that fails loudly when its anchor is not unique, which is exactly the guarantee you want while
  revising a plan you are also reading. Appending to `LOG_PATH` with a heredoc is fine; there is no anchor to match.
</constraints>

<auto_mode>
`--auto` in the request text (Stage 0a), `--lane` (which implies it) or the Stage 4 pick sets `AUTO_MODE = true`. Nothing else does. A
statement inside the topic prose ("auto mode enabled", "onay alinca otomatik execute et", "run it end to end")
leaves it false and only decides which Stage 4 option carries `(Recommended)`. Reading intent out of prose would
skip the one gate where the user sees whether the rest of the run is autonomous.

Auto mode automates system-process flow gates. It never auto-decides user-preference content.

| Call site | Class | Under `AUTO_MODE = true` | Under `LANE_MODE` |
|---|---|---|---|
| 0a Topic missing | BLOCKER | surfaces | returns `BLOCKED` |
| 0e Resume? | flow | auto-pick `Resume` | auto-pick `Resume` |
| 0f Plan collision | flow | auto-pick `Append suffix`, deliberately NOT the first option; preservation beats silent destruction | returns `BLOCKED` |
| 3a Proceed after synthesis | interview | surfaces | returns `DECISIONS` |
| 3b.1 TDD node | interview | surfaces | returns `DECISIONS` |
| 3b.2 QA node | interview | surfaces | not asked: records `QA = false`, since `execute --lane` skips the QA pass |
| 3c Every decision node | interview | surfaces | returns `DECISIONS` |
| 3d Stalled? | flow | auto-pick `Continue` | auto-pick `Continue` |
| 3.5c Oracle returned CRITICAL | BLOCKER | surfaces | returns `BLOCKED` |
| 3.5c Premise failed? | BLOCKER | surfaces | returns `BLOCKED` |
| 4 Lock all | flow | auto-pick `Lock all and run on auto mode` | auto-pick `Lock all and proceed step-by-step`, so the lane never chains execute |
| Stage 5 write fails twice | BLOCKER | surfaces | returns `BLOCKED` |
| Subagent malformed twice | BLOCKER | surfaces | returns `BLOCKED` |

Flow gates resolve to the `(Recommended)` option and emit one heartbeat line, `Auto mode: <header> -> <option>`.
Interview gates surface whatever the mode, because they are preference content rather than process flow; the Stage 3
recommendations are grounded in Stage 1 research and Stage 2 deep read, and the user picks among them. BLOCKER gates
surface whatever the mode, because they need judgment auto mode cannot supply. Nothing moves a surfaced gate on
without the user: the turn ends on the `question` call and the run waits for the answer.

The anti-runaway guards are the loop bounds, not this table: Stage 3d fires after three non-progress
interview turns, and the chained execute run bounds its own side. Heartbeat is one short line
per stage transition and per auto-resolved gate; interview gates emit none, since the user's answer already shows in
the chat.

Under `LANE_MODE` the last column replaces the `AUTO_MODE` one: `returns` means the gate writes `pending_decisions[]` and
ends the turn with a status block, never a question. The Stage 3.5 oracle trigger evaluation still runs; only its
CRITICAL and Premise questions become `BLOCKED` blocks. Two flow gates depart from the auto-mode pick under a lane.
Stage 4 skips its `(Recommended)` option, because that option chains execute and the coordinator is the only one
that decides when execute runs. 0f returns `BLOCKED` instead of appending a suffix, because the coordinator archives
only `.ac/plans/<slug>/`, so a plan written under `<slug>-2` would never reach it.
</auto_mode>

<lane_mode>
How an entry is written and how a lane resumes. The status block itself is defined in
`../coordinate/references/lane-protocol.md`; this section adds nothing to it.

- **Entry.** One `pending_decisions[]` entry per question, in the decision-entry shape of the protocol (`id`, `header`,
  `question`, `options`, `recommended`), plus `gate: interview | blocker` for the resume. Ids run `d1`, `d2`, ... within
  the run. The `header` stays at 12 characters or fewer; the two blocker headers `Oracle CRIT?` and `Premise failed?`
  are the exception and go out verbatim, so the coordinator asks them under the header the gate used. An option label is
  one token: drop `(Recommended)` and join the words with hyphens (`Revise-plan`); `recommended` is the label that
  carried the marker, and the consequence is the option's own description. The `Proceed?` entry carries the Stage 3a
  synthesis lines in its `question`, because the coordinator never sees a chat render.
- **Blocker class.** A `BLOCKED` block from this skill uses `class: plan` and carries the gate's header in `header`
  (`Oracle CRIT?` and `Premise failed?` verbatim), so the coordinator can ask it under that header.
- **Batching.** A returning turn carries every node that is independent at that point, so the Stage 3a pair (`Proceed?`
  with `TDD?` or `Tests?`; `QA?` is never asked in a lane) goes together and later 3c nodes with no edge between them go together. Each round trip costs the coordinator a resume, so
  one node per turn is the failure. A node that depends on another waits for the next round.
- **Resume.** The lane is resumed with `ANSWERS` (one `<id>=<label>` per line) after a `DECISIONS` block and with
  `RESOLVE <label>` after a `BLOCKED` one. Look each id up in `pending_decisions[]`, lock the answer with the rationale
  `relayed by coordinator`, append the question and answer to `LOG_PATH`, empty `pending_decisions[]` in the
  checkpoint, then continue from the interrupted stage: prune the remaining tree as usual and return the next
  independent nodes, or move on when none remain.
- **Revise.** A `REVISE` message after PLANNED carries the reason on its following lines. With this body still in
  context, address exactly that reason in `PLAN_PATH` with `edit`, rerun Stage 5's `plan-check` and the Stage 5.5
  review, and end with `PLANNED` (or `DECISIONS` when the change needs an owner answer). When the body is gone, the
  lane loads this skill again after writing the request line `Request: <slug> --lane --slug <slug> --revise <reason>`
  with the reason on the same line: `--revise` skips 0e, 0f and Stages 1 to 4, reads the existing `PLAN_PATH`, and runs
  the same revision, because Stage 6 already deleted the checkpoint and 0f would otherwise read the plan as a collision.
</lane_mode>

<bootstrap>
Nothing to load. `question` and `subagent` are direct tools, and there is no task list to register
(see Progress surface). Begin at Stage 0a.
</bootstrap>

## Stage 0: Setup

### 0a. Parse the request

Scan `REQUEST` for the `--auto` flag (anywhere in the string, surrounded by whitespace or at the start/end). If present: set `AUTO_MODE = true`, strip the flag from `REQUEST`, continue with the remaining string. If absent: set `AUTO_MODE = false`.

Scan the same way for `--lane`: if present, set `LANE_MODE = true` and `AUTO_MODE = true` and strip the flag; if absent, `LANE_MODE = false`. Then scan for `--slug <s>`: if present, set `SLUG_OVERRIDE = <s>` and strip both tokens. `--slug` works with or without `--lane`. Then scan for `--revise`: valid only with `--lane` and `--slug`; it jumps to the `Revise` entry of `<lane_mode>` with the remaining text as the reason.

If the post-strip `REQUEST` is empty:
- When `AUTO_MODE = false`: call `question` (header `Topic?`, question asking for the topic, single option `Provide topic`; the user types the topic as free text). Wait for input, then continue.
- When `AUTO_MODE = true`: this is a BLOCKER (auto mode cannot proceed without a topic). Surface the same `Topic?` question; the user provides the topic; auto mode resumes after. Under `LANE_MODE` the question is returned as a `BLOCKED` block instead (the `<auto_mode>` table).

If the post-strip `REQUEST` matches `.ac/tasks/*.yaml`, `read` the YAML and extract `type`, User Story, and Acceptance Criteria as the request body. Otherwise treat `REQUEST` as a free-form topic.

If `AUTO_MODE = true` and `LANE_MODE = false`, emit a single user-visible line: `Auto mode engaged. Will run end-to-end through planning and execution, halting only on BLOCKER classes.` Under `LANE_MODE` emit `Lane mode engaged. Planning only; questions go back to the coordinator.`

### 0b. Derive slug and paths

When `SLUG_OVERRIDE` is set, `SLUG = SLUG_OVERRIDE` verbatim and derivation is skipped (the caller names the plan directory so it can find it again); `PROJECT_DIR_HINT` stays unset. Otherwise read `references/slug-derivation.md` and apply it. It carries the seven ordered steps (path-strip, tokenize, Turkish ASCII fold, stopword filter, tech-stack preference, truncate to 5, normalize), the empty-slug fallback, and five worked examples.

Set:

- `PLAN_DIR = .ac/plans/<SLUG>/`
- `PLAN_PATH = .ac/plans/<SLUG>/plan.md`
- `LOG_PATH = .ac/plans/<SLUG>/interview-log.md`
- `CHECKPOINT_PATH = .ac/plans/<SLUG>/checkpoint.json`
- `RESEARCH_DIR = .ac/plans/<SLUG>/research/`
- `EVIDENCE_DIR = .ac/plans/<SLUG>/evidence/`
- `PROJECT_DIR_HINT` (when step 1 stripped a path): becomes the Recommended default for the Stage 3 D1 project-location decision; user may override during the interview.

### 0c. Create directory structure

```
shell: mkdir -p .ac/plans/<SLUG>/research .ac/plans/<SLUG>/evidence
```

Directories only. The plan skeleton is scaffolded at Stage 5, not here: Stage 0f checks whether
`PLAN_PATH` already exists, so writing a skeleton before that check would make the collision branch fire
on every fresh run and silently rename the slug under auto mode.

Idempotent; safe to run on every invocation.

### 0d. Gitignore guard

In a git repo (`git rev-parse --git-dir 2>/dev/null` exits 0), run `git check-ignore -q .ac/`. If non-zero (path not ignored), append `.ac/` to `.gitignore` (create the file if missing) and print one line: `Added .ac/ to .gitignore so planning artifacts stay local. Use git add -f to track specific plan files.` Skip outside a git repo or when `.ac/` is already ignored. The check is idempotent; run it on every invocation.

Under `LANE_MODE`, when `.ac/` is not ignored, append it to `$(git rev-parse --git-common-dir)/info/exclude` (create `info/` and the file if missing) and never touch `.gitignore`: a lane commits on its own branch, so a `.gitignore` change would land in a lane commit, and the common dir gives one rule for every worktree. Print nothing.

### 0e. Resume check

If `CHECKPOINT_PATH` exists:
- When `AUTO_MODE = false`: read it and call `question` (header `Resume?`, options `Resume (Recommended)` / `Start fresh`).
- When `AUTO_MODE = true`: auto-pick `Resume (Recommended)` without surfacing the question. Emit one line: `Auto mode: Resume detected, restoring from checkpoint.`

On Resume: restore working memory from the JSON (topic, locked_decisions, locked_requirements, canonical_refs, deferred_ideas, codebase_state, conventions, reuse_map, qa, last_stage), jump to the stage indicated by `last_stage`. A resume invocation passes the checkpoint slug verbatim as the topic, so 0b re-derives the same slug; the restored `topic` then replaces it as the request. On Start fresh: delete the checkpoint, continue to 0f.

For the checkpoint JSON schema and write points, read `references/checkpoint-schema.md`.

### 0f. Plan collision check

If `PLAN_PATH` already exists and no checkpoint was just consumed:
- When `AUTO_MODE = false`: call `question` (header `Exists?`, options `Overwrite` / `Append suffix (<slug>-2)` / `Cancel`). Apply the choice.
- When `AUTO_MODE = true` and `LANE_MODE = false`: auto-pick `Append suffix (<slug>-2)` (NOT the literal first option `Overwrite`; auto mode's safer default differs from interactive mode per the `<auto_mode>` policy). If `<slug>-2` also exists, increment to `-3`, `-4`, etc. until a free slug is found. Update `SLUG` and all derived paths. Emit one line: `Auto mode: collision detected, appended suffix; new slug = <new slug>.`
- When `LANE_MODE = true`: never append a suffix, because the coordinator archives only `.ac/plans/<slug>/` and a suffixed plan would never be archived. The collision is returned as a `BLOCKED` block instead (the `<auto_mode>` table), with `class: plan`: write the checkpoint with `last_stage: "0"` and one `pending_decisions[]` entry with `gate: blocker`, header `Exists?`, a question naming the existing `PLAN_PATH`, options `Overwrite: delete the earlier plan directory and plan this bundle from scratch` / `Cancel: keep the earlier plan untouched and end the lane FAILED`, and recommended `Cancel`. A resume whose consumed checkpoint holds this pending `Exists?` entry re-enters 0f to apply the answer, despite the "no checkpoint was just consumed" guard above. On `RESOLVE Overwrite`: delete `PLAN_DIR`, checkpoint included, rerun 0c, and continue at Stage 1 under the same `SLUG`; the `<lane_mode>` resume skips its checkpoint write and only appends the answer to the fresh `LOG_PATH`. On `RESOLVE Cancel`: delete only the checkpoint this gate wrote, leave `PLAN_PATH` as it was, and end the turn with a final `FAILED` block whose `next` is `none`.

Stage 0 complete.

## Stage 1: Codebase Survey + Parallel Research

Goal: ground the request in evidence before asking the user anything. Two-step: the main agent first builds its own coarse mental map of the project (1a), then spawns the parallel research cohort (1b-1d) with briefs anchored in that map, then waits for all (1e). The main agent does not skip 1a; subagent paraphrases stacked on a missing baseline produce shallow plans.

### 1a-1d. Survey, then fan out

The main agent runs the directory survey itself; it is not delegated. Subagents launch with shallower context, so
you build the map and pass it down through the briefs. Write it to `RESEARCH_DIR/00-directory-survey.md`.

Read `references/research-fanout.md` for the survey command block, the dedicated reuse explore brief, and the brief shape every spawn follows.

Counts policy, which governs the fan-out and stays here:

- `ac/explore`: floor 4, target 7, including the dedicated reuse explore. Narrow plans land near the floor, broad
  ones near the target. One brief per independent angle; do not bundle.
- `ac/librarian`: floor 2, target 3. Brief 1 verifies idiomatic patterns against vendor docs, brief 2 covers known
  bugs and version-combo breakage, brief 3 adds OSS reference examples or a second library.
- `ac/oracle`: 1, only when the request signals architecture intent. Advisory and non-blocking; do not gate on it.
- Under `LANE_MODE` the coordinator's own research already mapped the surfaces: read the `research:` file the lane brief names at 1a, copy
  its anchors for this bundle into the directory survey (a file in `git diff --name-only <research sha> <base sha>` was changed by an earlier
  merge, so its anchors count as unanchored; an unreadable file means no anchors), and spawn at most 2 `ac/explore` (the 1c reuse explore
  counts toward them) and 1 `ac/librarian`, each only for an angle neither the brief nor that file anchors, none when they name the files and
  lines, and no Stage 1 oracle. Several lanes run at once against one shared request rate limit, and the coordinator's budget
  prices a planning lane at this cap. This replaces the shared-rate-limit cap below.
- Shared rate limit: call the `ac_models` tool once; when one group in its `groups` holds the provider of every
  chain head the cohort starts on (`explore`, `librarian`, `oracle`; the codefast preset), cap the cohort at
  3 `ac/explore` + 1 `ac/librarian` plus the optional oracle, in place of the floors above. That group allows 25
  requests per minute across all its models, so a wider cohort waits on 429s. The chains' last rungs sit outside it
  and only catch failures, so they do not lift the cap.

Every brief carries a `DEPTH` and a `BUDGET`, or the agent falls back to its own default and searches wider than
the angle needs. The reuse angle is one dedicated brief, not a clause added to the others. Issue all spawns in ONE
assistant message, each a `subagent` call with `background: true`.

### 1e. Wait, archive, checkpoint

A subagent that failed on its provider or returned nothing walks its model chain first (the standing rule on a
failed subagent); this branch is for what that cannot fix. A subagent returning malformed output (an answer in the
wrong shape) gets one re-spawn with a format reminder, and so does one whose chain came back `none`; a second failure
is a BLOCKER, `question` (header `Agent fail?`, options `Retry (Recommended)` / `Skip this angle` / `Abandon`),
surfaced even under auto mode, because dropping a research angle silently leaves the plan thinner than it claims. Under `LANE_MODE` it is returned as a `BLOCKED` block.

Wait for all spawned agents by ending the turn with a one-line status (under `LANE_MODE`, a `status: WORKING` block); each completion arrives as a notification that starts your next turn. Never poll one with a `sleep` loop, by re-reading its output, or by asking the subagent for status. Write each agent's output to `RESEARCH_DIR/<agent-type>-<short-slug>.md`. The directory survey at `RESEARCH_DIR/00-directory-survey.md` is already on disk from 1a. Write a checkpoint with `last_stage: "1"` and the gathered research summary.

Stage 1 complete.

## Stage 2: Main-Agent Deep Read

Goal: build your own mental model. Subagents found candidates; you read the code and make decisions. Apply this to every file referenced by Stage 1 results, not just the first.

### 2a. Read what decides something, not everything referenced

Stage 1 hands you a candidate list. Open what will move a decision, and read enough of it to move that
decision, rather than reading every path any agent happened to cite.

The order to reach for, cheapest first:

1. `grep` for the definition (`function name`, `class Name`, `export const name`, `def name`) when the question is
   "does this symbol exist and what is its shape". That is most reuse-candidate questions and it costs a fraction
   of a file.
2. `grep` with context when the question is "is this pattern really here".
3. `read` with `offset` and `limit` on the cited range plus surrounding context.
4. `read` in full only when the file is short, or when the decision genuinely turns on the whole shape:
   an interface you will conform to, a module you will restructure.

Trace call sites with a `grep` for the symbol name across the project when a candidate sits in a chain you intend
to change. There is no language server here, so read each hit's line rather than trusting the match count: a
comment, a string or a same-named symbol in another module looks identical in the result list.

Reading every referenced path in full admits the whole candidate set into a context that carries it for the
rest of the planning run. The stage exists to own the mental model, and a symbol confirmed with a definition
`grep` is owned just as well as one read across 400 lines.

Cover every candidate. Reaching each one cheaply is the point; skipping the fourth because the first three
were interesting is the failure to avoid.

### 2a.1. Verify before you trust

A subagent report is a claim, not a finding. Before any claim changes a decision, check it against the source:
open the `file:line` it cites, recount what it counted, grep the quote it quoted, and read the report against its
own tables. Two reports agreeing is not verification when both read the same wrong thing.

Append every refuted or corrected claim to `RESEARCH_DIR/verification-log.md` with the claim, the check, and the
verdict. The plan then cites verified facts rather than reported ones, and a refuted claim cannot quietly return
after a compaction has summarized away the memory of refuting it.

Verification is yours, on the main thread. Delegating the check to another subagent reproduces the problem it
solves. Procedure at `references/research-verification.md`.

### 2b. Classify codebase state

Sample 2 to 3 representative files and check linter, formatter, and type-checker configs. Tag the codebase with one of:

- `disciplined`: consistent style, configs present, tests cover the surface. Match patterns strictly.
- `transitional`: mixed styles, partial migrations visible. Ask which pattern to follow when it matters.
- `legacy`: older patterns, gaps in tooling, but coherent within its era.
- `chaotic`: no consistent style, no tests. Propose conventions and confirm with the user.
- `greenfield`: empty or near-empty. Apply modern best practices.

### 2c. Extract dominant conventions

Distill these from the files read:

- Naming pattern (camelCase, snake_case, kebab-case per file type)
- Error handling style (throw, Result, try-catch boundaries)
- Comment density (none, WHY-only, docblocks everywhere)
- Type discipline (strict, mixed, untyped)
- File organization (flat, nested, barrel exports)
- Import convention (relative, aliased, absolute)
- Path aliases (the alias-to-directory mapping, plus any mis-form that produces a build error)
- LSP false-positive whitelist (autoload-registered globals and structural hints the executor's diagnostics check
  should skip; the field keeps its name so plans stay shared with Claude Code)
- Test mount discipline (the one canonical mount pattern and any banned API, when test infrastructure exists)

- QA learnings (the lines of `## QA learnings` in `RESEARCH_DIR/00-directory-survey.md` that bear on the topic:
  how to boot and run the app, auth fixtures, stable selectors, flaky areas; `n/a` when the survey section is absent)

That is nine, `TDD` from 2c.1 makes ten, and `QA learnings` makes eleven. All eleven go into the checkpoint and
into the plan template's `## Codebase Conventions` section verbatim.

Extract all eleven, not the first six. The executor inlines this whole section into every worker briefing
and the worker does not open the plan, so a convention this stage does not set is a convention no worker
ever sees. Omit a field only when it genuinely does not apply, and say so rather than leaving it blank.

### 2c.1. Test infrastructure detection (drives TDD interview node)

Scan for test infrastructure: `package.json` scripts containing `test`, presence of `vitest.config.*` / `jest.config.*` / `bun.test.*` / `pytest.ini` / equivalent, and a `tests/` or `__tests__/` directory with non-trivial content. Record:

- `TEST_INFRA_PRESENT = true | false`
- `TEST_FRAMEWORK = <name>` (when detected): vitest, jest, bun test, pytest, go test, etc.
- `TEST_COMMAND = <command>`: extracted from `package.json`, `AGENTS.md` or `CLAUDE.md`.
- `E2E_FRAMEWORK = <name | none>`: the first browser or device test tool whose marker matches, in the order and with
  the markers listed in `../qa/references/detection.md` (the qa skill's reference, relative to this skill's
  directory: Playwright Test, Cypress, Laravel Dusk, Pest browser, Flutter integration_test). It feeds the 3b.2 QA
  node, since a project that already ships one makes a QA pass cheap to run.

This drives the Stage 3 TDD interview node: if `TEST_INFRA_PRESENT = true`, the planner asks the user whether to use TDD (defaulting to yes, since the infrastructure already exists). If `TEST_INFRA_PRESENT = false`, the planner asks whether to set up test infrastructure as part of this plan or proceed without tests.

### 2d. Internal feasibility synthesis

Synthesize internally, not yet shown to the user: what exists today (`file:line` per similar implementation), the
Reuse Map draft, the delta the request needs that does not exist, codebase fit (High / Medium / Low with a reason),
effort (Small 1-2 files / Medium 3-5 / Large 5+ cross-module), prerequisites, and the risks research surfaced.

Write a checkpoint with `last_stage: "2"`. Stage 2 complete.

## Stage 3: Grill-me Interview

Goal: walk down the decision tree with the user until every load-bearing decision is locked. Hybrid walk-down branching plus `multiple: true` for parallel independent decisions. Every question carries a recommended option grounded in research.

### 3a-3c. The interview walk-down

Read `references/interview-procedure.md` and follow it. It carries the synthesis preview, the
routing rule with its worked examples, the TDD and QA nodes, and the walk-down with its pruning and batching heuristics.

Four bounds hold whatever that file says, because they govern the whole stage rather than one node:

- **Every interview gate is asked.** Nothing continues one without the user's answer, whatever the mode. Under `LANE_MODE` a gate is returned to the coordinator, which asks the owner, and the lane waits for the answer.
- **The routing rule gates every question.** Before anything reaches the user, ask whether code can answer it (read
  the file), whether docs can (spawn `ac/librarian`), or whether only the user can (preference, business call, value
  judgment). Only the third class becomes a `question` call.
- **Every resolved node writes a checkpoint** with `last_stage: "3"`, so a compaction mid-interview resumes instead
  of restarting.
- **Every question and answer appends to `LOG_PATH`.** The log is the record; working memory is not.

### 3d. Stall handling

If three consecutive `question` turns produce no decision-tree progress (user answers in free text with hedging, or your follow-up keeps surfacing the same node), call `question` (header `Stalled?`, options `Continue (Recommended)` / `Force-finalize with recommended defaults` / `Abandon`). On Continue: keep going, no further limit. On Force-finalize: lock all remaining unresolved nodes with their recommended options, list them in the plan's `## Risks Accepted` section. On Abandon: write `.ac/plans/<slug>/abandoned.md` with the synthesis and last state, exit.

### 3e. Convergence

The interview is complete when:

- Every node in the decision tree is locked, deferred to the backlog, or explicitly risk-accepted.
- No question remains that code, docs, or the user has not answered.
- The reuse-vs-build choice is explicit for every new piece of code the plan proposes.

Plan files contain zero open questions. If a decision could not be locked, it is either deferred (out of scope, captured in `## Deferred Ideas`) or risk-accepted (kept in scope with the recommended default and a note in `## Risks Accepted`).

Write a checkpoint with `last_stage: "3-complete"`. Stage 3 complete.

## Stage 3.5: Oracle Sanity Check (trigger-based)

Goal: a planning-time oracle pass that catches design bugs and idiomatic-pattern hallucinations before plan write. Run after Stage 3 interview concludes; evaluate the locked decisions against four trigger conditions. If any fires, spawn ONE `ac/oracle` in background with a focused brief; findings inline into the Stage 4 Synthesis Preview under a new `### Oracle Sanity-Check Findings` subsection. If no trigger fires, skip Stage 3.5 silently (no oracle spawn, no Stage 4 subsection).

### 3.5a. Trigger evaluation

Evaluate each trigger against the locked decisions, scope, and conventions from Stage 3:

1. **Security-critical surface in scope**: the locked plan touches authentication / authorization (login, password, session, token, RBAC, RLS, Policy / Gate, OAuth flow), payment / billing / financial calculation (currency math, charge, refund, invoice, ledger), cryptographic operations (hash, sign, verify, encrypt, decrypt, JWT, HMAC, password hashing), user-input → SQL / shell / file path (injection or traversal surface), or file upload / deserialization (RCE surface).

2. **Composable framework-API pattern adopted from librarian research**: the plan adopts a chained call (`.X()->Y()->Z()`) that librarian described as idiomatic but has unverified per-method semantics. Composable chains are the highest-frequency hallucination class (Laravel `middlewareFor(['index'], [])` adopted as "exempt index from auth" when it assigns empty middleware; React `useMemo` semantics adopted from a blog post when the docs say otherwise). Trigger fires when at least one such chain appears in the locked decisions OR the plan's intended Codebase Conventions.

3. **Conflicting research signals**: Stage 1 librarian or explore returned contradictory recommendations on the chosen path, OR the chosen path's evidence is single-source / low-confidence. Oracle as tie-breaker.

4. **Migration with destructive operations**: schema rename, `DROP`, `TRUNCATE`, data-shape change with no rollback path. Production-safety review.

Trigger evaluation is mechanical, match locked decisions and conventions against the surface lists above. If zero triggers fire: proceed silently to Stage 4. If one or more triggers fire: assemble ONE oracle brief targeting the fired triggers and proceed to 3.5b.

### 3.5b. Oracle brief shape

Spawn one `ac/oracle` with `subagent` and `background: true`, using the brief at
`references/research-fanout.md` under `## Stage 3.5 oracle brief shape`. Include only the GOAL
bullets for the triggers that actually fired. Leave the `model` parameter unset: the oracle runs on its own
configured model and variant, and the fallback chain for it comes from the plugin configuration.

### 3.5c. Wait, classify, route

Wait for the oracle the way 1e waits, by ending the turn until its notification arrives, then sort findings by severity. Under `LANE_MODE` the oracle still runs on its triggers; only the two BLOCKER questions below change, to `BLOCKED` blocks. A PLAUSIBLE finding names the check that would confirm it; run that check yourself before routing it. Confirmed, route it by its severity; refuted, drop it and log why; still open, list it in the Stage 4 preview as IMPORTANT instead of raising the CRITICAL BLOCKER.

Any CRITICAL finding is a BLOCKER: surface it before Stage 4 even under auto mode, via `question` (header
`Oracle CRIT?`, options `Revise plan (Recommended)` back to Stage 3 at the affected decision / `Accept as Risk`,
which locks the concern into `## Risks Accepted` / `Abandon`, which writes `abandoned.md` and exits). It is asked
under auto mode as well, and the run waits for the answer.

**A REFUTED premise is its own branch, and it outranks the finding severities.** The oracle returns a `**Premises**`
block classifying the claims your brief rested on. A premise it marks REFUTED, with a quote from the source that
contradicts it, is not a finding about the plan: it is evidence that the research under a locked decision does not
hold, so every decision downstream of it is now unsupported whatever else the oracle said. Surface it before
anything else, naming the premise and the quote, then `question` (header `Premise failed?`, options
`Re-research and re-decide (Recommended)` back to Stage 1 for that angle only / `Revise the decision without new
research`, when the refutation itself tells you enough / `Accept as Risk`, which locks it into `## Risks Accepted`
with the refutation quoted). A premise marked UNSUPPORTED does not halt; carry it into the Stage 4 preview so the
user sees which claims nobody could source.

IMPORTANT findings do not halt: inline them into the Stage 4 preview under `### Oracle Sanity-Check Findings`. No
findings means that subsection is omitted entirely.

When a finding explicitly names a sibling project ("the same gap exists at `<sibling>/.../foo.ts:N`"), record it in
the plan's `## Cross-Project Observations` at Stage 5. This plan absorbs the finding for its own scope only; the
sibling fix is a separate plan with its own interview and review. Never silently fix sibling code.

Append the outcome to `LOG_PATH` under `## Stage 3.5 Oracle Sanity Check` (triggers fired, findings count, routing
if the BLOCKER fired) and write a checkpoint with `last_stage: "3.5"`.

Stage 3.5 complete.

## Stage 4: Synthesis Preview

**The render and the question are one turn, and the question is the stage.** Append the full synthesis to
`LOG_PATH`, render the short form in the chat, then call `question`, all in the same turn.

Measured once: the planner rendered a 908-character summary reading "decisions locked, here is the summary before
I write the plan", ended the turn, and after the user typed "continue" went straight to Stage 5. The `Lock all?`
gate was never asked, so `AUTO_MODE` was never set. Length was not the cause and a shorter render would not have
prevented it: the two Stage 3 renders in the same run were 360 and 395 characters and both carried their question
fine, and the planner's own reasoning before the render already said it was moving on to writing the plan. Two
Stage 3 question rounds had made this one read as redundant, and the whole procedural layer was degrading
at that point in the run (no checkpoint was written either). The forcing function is in Stage 5 rather than here:
`plan-scaffold` refuses to run without this stage's answer.

Render the locked synthesis in the chat using the shape at
`references/interview-procedure.md` under `## Stage 4 synthesis preview shape`, capped at
roughly 2 KB on the cost grounds the Output length standing rule already argues: the Goal in one line, the Scope
IN and OUT lists, the Locked Decisions table, the hard constraints research produced, and a one-line pointer to
`LOG_PATH` for the rest. Codebase Conventions, the Reuse Map, the Canonical References and the full Deferred Ideas
list go to `LOG_PATH` only; they are inputs to the plan file you are about to write, not a decision the user is
being asked to make here.

Then call `question` (header `Lock all?`):

1. `Lock all and run on auto mode (Recommended)`: sets `AUTO_MODE = true`, auto-resolves the remaining flow gates,
   and chains into the execute skill with `<slug> --auto` at Stage 6. The default once decisions are locked, because
   the interview and the Stage 5.5 reviewer already carry the quality bar.
2. `Lock all and proceed step-by-step`: write the plan, run the review, then stop and let the user run execute.
3. `Revise a decision`: loop back to Stage 3 targeting one node.
4. `Revise / expand scope`: change what is IN or OUT, or pull a deferred idea into v1; loops back to Stage 3.

This is the only gate where the user sees whether the rest of the run is autonomous, so it fires whenever `--auto`
was absent; auto mode skips it and proceeds as if option 1 were picked. Under `LANE_MODE` it is skipped as option 2
(`Lock all and proceed step-by-step`) and `plan-scaffold` gets `--auto-mode false`, so the plan frontmatter never asks
the coordinator's execute to run on auto.

Stage 4 complete.

## Stage 5: Plan Write

Scaffold the skeleton first, then fill it in with `edit`:

```
shell: node "$AC_CLI" plan-scaffold <SLUG> --auto-mode <true|false> --qa <true|false>
```

`AC_CLI` is set in every shell by the ac plugin and names the ac CLI installed with it; never substitute a path of your own, since a pinned install and the repository's working tree can differ.

`--auto-mode` is required and takes the Stage 4 `Lock all?` answer: `true` for option 1, `false` for option 2.
There is no other source for it and no default. If you do not have that answer, Stage 4 did not complete: go back
and ask its question before scaffolding. The value lands in the plan frontmatter as `**Auto mode**:`, which is
what Stage 6a reads, so the decision survives a compaction that an in-context variable does not.

`--qa` is required too and takes the Stage 3 QA node (3b.2) answer: `true` for `Yes, QA pass after review`,
`false` for `No QA pass`. It lands as `**QA**:` on the line after `**Auto mode**:`, which the execute skill's
Phase 3e reads, so the choice survives a compaction the same way.

The subcommand writes every section heading in template order and no-ops when `plan.md` already exists, so a
resumed run cannot clobber a filled-in plan. Fill it with `edit`; a `write` on `PLAN_PATH` erases the skeleton,
and a second `write` erases the first call's output.

Under `## Steps` the skeleton carries a worked step stub rather than a `<fill>` marker. Follow it exactly and
delete it once the real steps are written. The two fields in it that a downstream tool parses rather than reads
are the `- [ ] **Step N**:` line, which Layer D ticks and the stop guard counts, and `Type`, which is one of
`code`, `infra` or `verification` and which the executor routes on with no branch for any other value. Measured
once: a plan written from memory instead of from this shape carried neither, and the executor spent a user gate
and 18 repair edits before its first worker spawned.

Write the plan to `PLAN_PATH` using the markdown structure at `references/plan-template.md`. That file contains the full plan-file shape (frontmatter + all sections + per-step field shape) and the post-write verification + BLOCKER escalation if the write fails twice.

Fill placeholders with concrete content; remove placeholder text inside angle brackets. For tier assignment per step, read `references/model-tiers.md` (capability summaries + decision heuristic). For plans with more than 10 steps, use the incremental write protocol described in the template reference.

**Write the plan as if no reviewer will look at it.** Stage 5.5 is a single advisory pass, not a loop that will grind a draft into shape, so a plan that arrives there needing work simply ships with the findings deferred. Concretely: every step's Description / Files / Done when / QA / Must NOT is specific enough that a fresh agent can execute without guessing; the Codebase Conventions section captures every project-specific rule the workers need; the Reuse Map names every existing utility the plan leverages; the locked decisions from the interview are reflected in the steps themselves, not assumed.

**Test-driven literal-pattern audit (Stage 5 quality discipline)**: when a step's Description names a literal regex pattern, a literal config snippet (package.json fragment, tsconfig field, command-line invocation), or a literal API chain (`.X().Y().Z()`), AND the same step's QA or Done when field lists concrete test inputs that exercise it, execute the pattern against each of those inputs in your head BEFORE plan write. If any listed input would fail the literal as written, either fix the literal in the plan or flag the gap in the step's Description as `regex-needs-validation`, `snippet-needs-validation`, or `chain-needs-validation`. The worker's TDD red phase is the safety net for what this misses; catching it at planning time is cheaper. The template reference carries a worked example of the class of bug this finds.

**Negative-test audit (Stage 5 quality discipline)**: for every `Done when` criterion that names a shell command, answer one question before plan write: what input would make this report a failure. Run the command in your head against that input. Two shapes cannot answer it and both get flagged in the step's `Done when` as `criterion-needs-negative-test`. A flag the tool does not support, where the shell exits non-zero with empty stdout and "returns nothing" reads as clean: `grep -P` on macOS is the measured case, and `rg` is the replacement. A pipeline that truncates before the asserted value appears, `head` being the usual culprit. Then, for any criterion naming a number, read that number against the fixture the same step sets up; when the step's own inputs cannot reach it, the criterion is wrong rather than unmet, so fix the criterion. The template reference carries both failures with their measurements.

**Shape gate before the reviewer.** Run it once the plan is written:

```
shell: node "$AC_CLI" plan-check <SLUG>
```

It exits 1 and names every deviation the executor would hit: a checkbox count that disagrees with the `Steps`
frontmatter, a `Type` outside the three, a worker step with no `Tier`, a verification step with no `Commands` or
`Evidence`, a scaffold placeholder left in place. Fix every ERROR with `edit` and re-run until it exits 0. WARN
lines are yours to judge.

This runs before Stage 5.5 because the reviewer reads prose and would spend a pass reporting what one command
settles for free. It is also the last point where the fix is cheap: the same defects found at execute time cost a
user gate and a repair pass with the run already started.

Stage 5 complete.

## Stage 5.5: Independent Review

Goal: one second-eye read of the written plan by a fresh-context subagent that sees only the plan file.
It catches what the planner's own context bias hides: stale references after revision, executability
from a cold start, tier assignments that drifted while writing.

It is ONE pass and it is advisory. There is no verdict and no loop.

### 5.5a. Spawn the reviewer

```
subagent({
  agent: "ac/plan-reviewer",
  description: "Independent plan review",
  prompt: PLAN_PATH
})
```

The prompt is the path and nothing else. The fresh context IS the second eye; adding your own context to
the prompt destroys the property while looking like an optimization.

### 5.5b. Act on the findings, then move on

The reviewer returns findings tagged CRITICAL or IMPORTANT, with no verdict. You are the filter:

- **CRITICAL**: fix it with `edit` before Stage 6. These are the ones that make a step unexecutable by a
  fresh agent: a reference that does not resolve, a step whose `Done when` cannot be satisfied by its
  `Files`, an internal contradiction between two steps.
- **IMPORTANT**: fix it when the fix is small and local. Otherwise record it in the plan's
  `## Deferred Ideas` with one line naming what was deferred and why.
- Anything else goes in `## Deferred Ideas` or is dropped.

After any edit, grep the plan for each string tied to the changed substance and patch every survivor.
One step restates the same rule across `Description`, `Why this tier`, `Done when`, `QA`, `Must NOT` and
`References`, so a single-field edit leaves contradictions behind. No later pass catches the survivors, so
the sweep happens here.

Re-run `plan-check` after the last edit. A reviewer fix is the likeliest way to break the shape the gate just
confirmed: splitting a step or dropping one changes the count the `Steps` frontmatter declares, and nothing else
in this stage would notice.

Append the outcome to `LOG_PATH` under `## Stage 5.5 Review`: findings by severity, what was fixed, what
was deferred. Then write a checkpoint with `last_stage: "5.5"`.

### Why this is one advisory pass and not a gate

Measured across 26 plans and 88 reviewer runs: 82 REJECT against 5 OKAY, a 94% reject rate, with 69% of
plans hitting the 3-pass cap and 27% exceeding it. Eighty-eight passes produced five approvals, so about
80% of plans left the loop by hitting the cap and having the operator pick `Proceed anyway`. The override
was already the norm; this stops paying 3.4 reviewer passes to reach it.

The 94% was not a quality signal, it was a self-contradiction in the agent: it was told to report
everything and let a downstream pass filter, while its own verdict rule blocked on three accumulated
IMPORTANT findings, so the downstream filter never ran. Removing the verdict is what lets the reporting
instruction work as intended.

The reviewer still catches real defects, which is why it stays: a plan claiming an API registered lazily
when it does not, a plan whose auth objective no step actually implemented. Those are CRITICAL findings
and they get fixed. What is gone is the machinery that turned every plan into three passes.

## Stage 6: Deliver

Delete `CHECKPOINT_PATH`. The plan is locked and reviewed.

Render the plan summary using the template at `references/plan-summary-template.md`. Fill concrete values from the plan file. Under `LANE_MODE` skip the summary: the coordinator reads the status block and nothing else, so end the turn with `status: PLANNED`, `plan` set to the absolute `PLAN_PATH` and `steps` counted from its checkboxes.

Stage 6 complete.

### 6a. Auto-mode chain

Read `**Auto mode**:` from the plan frontmatter rather than trusting the in-context `AUTO_MODE`. Stage 5 wrote it
there from the Stage 4 answer, and the file is what survives a compaction between the two. They agree on any run
that went through Stage 4; when they disagree, the file is right and the variable was lost.

When `LANE_MODE = true`, skip this chain whatever `AUTO_MODE` holds; the coordinator runs execute.

When `AUTO_MODE = true` and `LANE_MODE = false`, do not end the turn after the summary. Emit one line naming the handoff,
`Handing off to execute: <slug> --auto`, then load the execute skill with the `skill` tool (id `execute`) and
continue with the slug: skills take no arguments, so that handoff line is the execute skill's request text (the
slug plus `--auto`). Keep going in the same turn until execute reaches its own terminal state or a BLOCKER halts it.

When `AUTO_MODE = false`, end the turn after the summary. The user reviews the plan and runs `/ac/execute <slug>` themselves.

<reminders>
- Reach every candidate yourself by the cheapest tool that settles it, and verify subagent claims before they move a decision (Stage 2a.1).
- Route every question through the three-way test; every load-bearing decision ends locked, deferred, or risk-accepted.
- Stage 4 renders the short synthesis and calls `question` with `Lock all?` in the SAME turn. The render never ends the turn, and a resumed run that finds itself at Stage 5 without that answer goes back for it.
- `plan-check` exits 0 before Stage 5.5 spawns and again after its last edit. Every step carries a `- [ ]` line and a `Type` of `code`, `infra` or `verification`.
- The reviewer receives a path and nothing else, runs once, and returns findings rather than a verdict. Fix CRITICAL with `edit`, defer the rest.
- Do not start execute when `AUTO_MODE = false`. The user reviews the plan first.
</reminders>
