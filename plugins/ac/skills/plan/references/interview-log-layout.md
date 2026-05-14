# Interview Log Layout

Markdown structure for `.ac/plans/<slug>/interview-log.md`. The log is the audit trail of the planning interview: every research spawn, every decision-tree node, every user selection, every audit finding. It complements the plan file (which is the spec) by recording the conversation that produced the spec.

## When to read this

Read when writing or appending to `LOG_PATH`. The log is append-only across stages; a per-node `Append` happens in Stage 3 (one append per resolved decision), and a per-stage `Append` happens at the end of each stage that needs to leave a trace.

## Template

`.ac/plans/<slug>/interview-log.md`:

```markdown
# Interview Log: <slug>

## Stage 0 — Topic
<original topic>

## Stage 1 — Research Spawns
- agent: ac:explore — brief: <one-line> — result: research/<file>.md
- agent: ac:librarian — brief: <one-line> — result: research/<file>.md
- agent: ac:oracle — (if spawned) brief: <one-line> — result: inline below

## Stage 2 — Feasibility Synthesis
<the internal synthesis from Stage 2d>

## Stage 3 — Interview
### Node 1: <decision label>
- Question: <text>
- Options: <list>
- User selection: <choice>
- Notes: <freeform>

### Node 2: ...

## Stage 4 — Synthesis Lock
<rendered preview from Stage 4>

## Stage 5 — Plan Write
- Path: .ac/plans/<slug>/plan.md
- Waves: <N>
- Steps: <N>
- Tier distribution: <N quick / N junior / N senior>

## Stage 5.5 Iteration <N>
- Reviewer verdict: REJECT
- Issue count: <N>
- Issues addressed: <list of section/step references>
- Notes: <freeform>
```

## Append discipline

- Stage 3 per-node: append after every resolved AskUserQuestion turn (or auto-resolved node in auto mode), including the question text, the options presented, the user's selection (or `Auto mode: (Recommended) → <chosen option>`), and any freeform notes.
- Stage 4: append the rendered Synthesis Preview.
- Stage 5: append a one-paragraph wrap-up with wave / step / tier distribution.
- Stage 5.5: append one `## Stage 5.5 Iteration <N>` block per reviewer turn.
- Auto mode: the log records the same content as interactive mode; the `User selection:` line reads `Auto mode: (Recommended) → <chosen option>` and emits a heartbeat line per resolution.
