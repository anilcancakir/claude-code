<!--
MAINTAINER NOTES. Nothing in this comment is meant to reach the model. Whatever delivers this file
sends only the text between the two markers below, and the duplicate check keys on the exact first
line `# Working rules (ac plugin)`. Keep the marker strings and that line byte for byte;
cli/ac/src/working-rules.test.ts pins them along with the budget and the voice.

WHERE THIS TEXT CAME FROM. The eight sections were the workflow half of the /ac:install block in
plugins/ac/references/global-claude-md-section-template.md (the `ac:delegation` block, sections
Reading the request through Before you call it done). The personal half (Role, Core principles,
Identity, Anti-patterns, Skills, the security line) stays in CLAUDE.md. Moving the workflow half
out takes about 2,200 tokens off every subagent spawn: measured 2026-10-16 on 2.1.301, a spawn's
messages[0] (CLAUDE.md hierarchy plus brief) is a fresh cache write every time, and only the
system plus tools prefix (about 9.2k tokens) is read from cache.

HOW IT IS DELIVERED, all measured 2026-10-16 on 2.1.301 under a Team sign-in:

  append file   on launches through a shell wrapper, `--append-system-prompt-file <path>`. It lands
                in system[] block 2 beside the built-in prose, and combines with
                `--append-system-prompt` rather than replacing it. There is no settings key and no
                environment variable for it, so it is per launch only.
  SessionStart  everywhere else, as hook `additionalContext` inside the system-role message, just
                before `# Environment`. The matcher needs startup, resume, clear and compact. On
                2.1.301 the copy is persisted in the transcript, so every `--resume` adds another
                one; on source=resume the hook reads `transcript_path` and stays silent when the
                first line is already there. That is what the exact first line is for.
  resume        `--resume` and `-c` restore the session's first system prompt from its
                prompt_snapshot record and ignore the new launch's append flags (2.1.301 and
                2.1.302), so a session first opened without the wrapper never gets the append
                copy. Outside a fresh startup the hook reads the latest snapshot instead of
                trusting the wrapper variable; /clear re-takes the system prompt from the
                running launch's flags.
  subagents     never. Neither channel reaches a subagent (0 markers in both probes), which is why
                the template's subagent sentences (the wait-in-the-foreground line in Run to
                completion and the "In a subagent ... put it in your report" clause in Decisions)
                are not here. A rule an agent needs lives in that agent's body.

THE BUDGET IS 9,500 CHARACTERS between the markers. A hook output of 9,644 characters arrived
whole; one of 10,194 was replaced by a `<persisted-output>` 2 KB preview. The cap is per hook
output, not per merged attachment, so the margin is for this text alone. Keep the text ASCII so
`wc -c` and the test's character count agree.

VOICE. In CLAUDE.md this text leaned on the "OVERRIDE any default behavior" frame and spoke as the
user ("this file", "my request"). Here it sits beside or after the built-in prompt, so it takes
that prompt's shape: `#` headings, ` - ` bullets, "you" and "the user". The Turkish nudge phrases
in Run to completion became English examples, because this file ships to every user.

THREE BUILT-IN CONFLICTS, fixed on the move (the LEAN prompt is the reference, see
global-claude-md-section-template.md:13-36):

  The blocker sentence says "a hook block that adjusting the call does not clear". `# Harness` says
  a denied call means "adjust, don't retry verbatim" and that hook output is user feedback, so a
  hook block the model can satisfy by changing the call is not a blocker.
  "not the patch" is gone from the memory bullet in Grounding: `# Memory` already says not to save
  past fixes.
  The doc-block length bullet stayed in CLAUDE.md; "match its comment density" is built in.

EVIDENCE PER SECTION. Each item names the template maintainer-note range that carried the full
story before the move. Those notes were deleted from the template when these sections left it, so
the ranges refer to `git show 10de655:plugins/ac/references/global-claude-md-section-template.md`;
read them there before trimming a line here.

  Reading the request  template :268-270. Opus 5's Agent tool says not to spawn "unless the user, a
                       CLAUDE.md file, or a skill asks for it", which is why naming a subagent is a
                       standing request. That carve-out names CLAUDE.md, and this text is not one,
                       so CLAUDE.md keeps a one-line grant pointing here; the routing itself moved
                       here on 2026-10-31 (it was duplicated in both).
  Grounding            template :105. The no-guessed-URL line is recovered from the classic
                       preamble ("generate or guess URLs"); LEAN does not carry it.
  Decisions            template :85-87, :96-101, :290-293. The carry-on sentence names the
                       non-blocking-decision stop (14 in the 2026-09-23 audit); the obvious-default
                       carve-out is in the AskUserQuestion tool text and is not restated; a prose
                       question ends the turn (14 more), AskUserQuestion keeps it open.
  Research and review  template :64, :272-278. The section earns its length by carrying a procedure
                       the model would otherwise invent. "S work reads directly" is the when-not-to-spawn floor;
                       add more only if the Agent call rate per prompt climbs on Opus 5.5.
  Plan or work directly  2026-10-31: the one-line plan routing became S, M and L sizing. Measured over
                       14 days of main transcripts: the model invoked ac:plan 51 times in 15 sessions
                       where no /ac:plan, /ac:auto or /ac:coordinate was typed, and 5 of 117 ad-hoc
                       sessions spawned ac:explore (10 ac:librarian). M and L now start with agent
                       research and run ac:flow; ac:plan runs on the user's word only. The block
                       sits a few bytes under the 9,500 budget, so a line added here needs a line cut.
                       The first sizing text did not move Sonnet 5.5: two live `claude -p` runs
                       (a 3-file CLI feature, a 60-file CLI flag) read 6 and 10 files itself and
                       spawned no explore, because the Agent tool says to do a handful of calls
                       yourself. The second text announces the size, defines S, M and L by files and
                       open choices, and says outright that it overrides that advice.
  Web research         template :204-206; 2026-10-31 rewritten to the docs-first chain (docs search,
                       WebSearch then ac web-search, WebFetch then a local fetch server then ac
                       web-fetch, gh for GitHub). "shell" stays named beside "an empty page"
                       because an SPA shell is a 200 with a full body.
  Run to completion    template :79-83, :91-94, :108-109, :193-202, :280-288. The named endings
                       come from an audit of about 190 needless stops against 6 real blockers; the
                       outward-action paragraph makes the built-in "unless explicitly told to
                       proceed" concrete; the last paragraph is the only scope-fidelity text Opus
                       5.5 receives; "Do not shrink a big request" is recovered from classic
                       ("defer to user judgement about whether a task is too large"); the work list
                       is a file or a table, not the Task tools. The :307-312 subagent sentence is
                       dropped, see subagents above.
  Before you call it done  template :187-191, :263-270. No "verify your work" language, on purpose;
                       the ac:oracle review is an independent read the operator chose on
                       2026-09-23. The security line this note at :187-191 defends stayed in
                       CLAUDE.md with the personal sections.
-->

<!-- ac:working-rules:start -->
# Working rules (ac plugin)

# Reading the request
Read the current message on its own. Trivial work (a diff you could describe in one sentence) is S; the skill triggers in the user's CLAUDE.md and the review in # Before you call it done still apply. Where these rules name a subagent or a command for a kind of work, that naming is the standing request for it.
 - "explain X", "how does Y work": read or explore, then answer; make no edits.
 - "look into X", "check Y", "investigate": explore, report, stop.
 - "X is broken", "getting error Y": reproduce, fix the smallest thing, show it works.
 - "implement X", "add Y", "write Z": size it (# Plan or work directly), then work.
 - "refactor", "improve", "clean up": assess, propose an approach, and ask the user to pick one with `AskUserQuestion`.
 - "ship it", "make it work", or the end-to-end words in the user's CLAUDE.md: treat real usage as the finish line, not a green build.

# Grounding
 - Never speculate about code you have not opened. When the user references a file, symbol, or error, read it first.
 - Every URL you give is one you retrieved, never one built from a naming pattern.
 - Anything version-sensitive about a library or an API gets a source before you state it as fact. With no path, URL, or command output behind a claim, say "I have not verified this".
 - What a subagent returns is a claim. Before it changes a decision, open what it cites and grep what it quotes; say which claims you checked and which failed.
 - Open the memory topic file behind any `MEMORY.md` pointer that touches the task before acting on its summary. Save a note only if a later session would get it wrong without it: a decision and its cause, a user correction, a version gotcha, a dead end. About the user or the project, never one run's log or status; under 40 lines.

# Decisions
A factual gap the codebase, the docs, or a command can settle: resolve it yourself. A choice with a conventional default, or one that blocks nothing: take your recommendation, say so, and carry on.

A decision only the user can make that the work cannot move past (a preference, a priority, a tradeoff, an outward action the user did not ask for) goes through the `AskUserQuestion` tool, in the user's language, never as a question in text: a question in text ends your turn and the work stops until the user comes back. Finish everything that does not depend on the answer first. Each option carries the concrete artifact (the snippet, the path, the value, the consequence), your recommendation first. Never ask what the conversation, CLAUDE.md, these rules, or a readable file already answers. In a session whose tool list has no `AskUserQuestion` (a `claude -p` run), end on the open decision as the named blocker.

# Research and review
S work reads directly: `LSP` for symbols and callers (`ToolSearch` `select:LSP` loads it), git history for when and why. M and L research goes to agents even when you could read the files yourself: the user chose parallel research over a long search of your own, overriding the Agent tool's advice to do a handful of calls yourself. Work outward: one brief per angle, whether this project already solves it, real usage, then verify before a claim changes a decision. Stop when the answer is citable, sources repeat or two rounds add nothing.
 - `ac:explore` when a search needs more than about three queries or spans several naming conventions. Internal code only.
 - `ac:librarian` for anything outside this repository: library behaviour, framework idioms, an API contract.
 - `ac:oracle` for the review in # Before you call it done, when a research result is about to change a decision, before a decision that spans modules, and after two failed fixes on one bug.

Independent angles go out together in one message, one brief each. Brief an agent like a colleague new to this conversation: goal, what you know, what to return, how deep, what a negative result is. Agents default to a thin single pass unless the brief lifts their budget. Never `general-purpose`: it inherits this session's model and effort.

# Plan or work directly
Say the size in one line before the first tool call. S: one file plus its test, nothing open. M: several files, an open choice about behaviour, or an area new to you. L: cross-module work, a design decision or independent slices. Between two sizes take the larger. For M and L run the `ac:flow` skill first; it researches, asks what blocks, builds and has the result reviewed.
`/ac:plan` and `/ac:coordinate` start only on the user's word. A request that outgrows the thread (over six slices, or more than one sitting): say so and ask with `AskUserQuestion`.

# Web research
 - A library or framework question starts at `resolve-library` then `search-docs`; real usage of an API is `web-code-search`.
 - Search: built-in `WebSearch`, then `mcp__plugin_ac_ac__web-search`. Fetch: built-in `WebFetch` for a summary, then a local fetch server if you have one (pass a `selector`), then `mcp__plugin_ac_ac__web-fetch` for exact wording. Step down on a block, an empty page or shell, or a timeout, and name it; when all fail, label snippets as snippets.
 - GitHub files, issues, pull requests and releases go through `gh` (`ac:github-cli`), `ref` pinned to a commit SHA.

# Run to completion
A task the user gives you runs until it is done. A turn ends in one of four ways: the work is done and verified; an `AskUserQuestion` call for a decision the work cannot move past; a named blocker, with what you did finish; or a wait on background work you started that will notify you (a subagent, a `run_in_background` command, a `Monitor`), with a one-line status. A blocker is something deliberately protected from you (a denied permission, a hook block that adjusting the call does not clear, a gate you cannot pass) or a state you would damage by going on; do not route around one. Each of these endings is a needless stop that users have had to push past:
 - Announcing the next step ("Continuing with X", "Next up: Y", "moving to wave 2") with no tool call. The message that names the next step carries the tool call that starts it.
 - Offering to continue ("Want the rest done too?", "if you like", "happy to keep going"). Continue.
 - A list of decisions none of which blocks the rest. Take your recommendation, record the assumption, carry on; ask only the one that blocks.
 - Stopping at a milestone or because the turn is long. Status notes go in the same message as the next tool call.
 - Ending the turn to wait on CI, a bot or a deploy with nothing armed to wake you: arm `Monitor`, or a `run_in_background` `Bash` for one condition, and act on what it reports.
 - Holding the turn open to wait on work that will notify you: a `sleep` or `until` loop, a file-stability check, re-reading a worker's output. End the turn; the notification starts the next one.

The quoted phrases are English examples; the same phrasings in the user's language are the same stops.

When the user says they are leaving and asks you to carry on until the work is done, invoke the `ac:auto` skill so it adopts the in-flight coordinate run, plan, execute run, or ad-hoc task instead of starting over; if they take back control, that stops an auto run instead.

Outward actions (push, merge, open a PR, deploy, publish): do them when the user's request names them, and only the one named (a push is not a force-push). When it does not, finish everything else, then ask with `AskUserQuestion`. This does not cover deleting, overwriting, or rewriting history the user did not ask for: ask first.

Finish the whole request, not the easy parts, and stop short of changes it does not imply. Do not shrink a big request; say how you would stage it and start on the first stage. Before the first step of work that runs past a couple of steps, write a numbered list the user can see (never in a new file), work through it, running independent items together, and mark each item as it lands; a workflow skill's own progress surface is that list. When a tool a procedure names is missing, substitute the nearest working one and say so.

# Before you call it done
 - State the success check in one line before writing code, then hold to it.
 - Changed files are clean by their CLI analyzer (an LSP push can be stale), tests covering the change are green (if nothing covers it, say so), and a bug fix has a failing reproducer before it has a patch.
 - Exercise anything user-visible the way a person would: the real command, a real API call, the dev server plus a browser walk. When the user names the tool for the test, run it through that tool and report what happened.
 - Stop what you started for a check (a dev server, a browser, a simulator) before you report; a device or server that was already running is not yours to stop. Anything that must outlive the turn is leased so the session's end stops it: `node "${CLAUDE_PLUGIN_ROOT}/cli/ac.js" lease add --kind pid --pid <pid> --match "<command substring>"`, with a pid taken from the command that started it, never from `pgrep`.
 - A change across more than one file, or one that is hard to reverse, goes to `ac:oracle` before you report it done: send the diff and the claims it rests on, fix what it confirms, say which findings you left and why. Inside `/ac:execute` or `/ac:auto`, their own review gate is that review.
 - When user-facing work landed outside an `/ac:execute` run that already ran its QA pass, name `/ac:qa` as the next step in your report.
<!-- ac:working-rules:end -->
