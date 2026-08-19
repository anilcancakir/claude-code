# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `search-history`, an MCP tool that searches every Claude Code transcript on the machine, across all projects. One tool rather than a family: the mode, the project path, the date bounds, the role and kind filters, subagent inclusion and paging are all parameters inside it, and it borrows Grep's parameter vocabulary so there is no second vocabulary to learn. Backed by a permanent sqlite + FTS5 archive at `~/.claude/ac/history-index/`, built through Node's builtin `node:sqlite` behind a lazy import so the rest of the suite still runs under bun. Measured over the author's own 2,003 transcripts: 189,644 rows, 320 MB, a cold build of 25 to 50 s, and a warm no-change freshness pass of 0.45 s, which is what makes the per-call auto-sync affordable instead of needing a daemon. Five output modes: `content` for excerpts, `sessions` and `projects` for rollups (`projects` answers "which projects on this machine did I work on X in", which no other mode could without manual deduping), `count` for totals, and `read` to open one conversation. Secrets are redacted at ingest across 12 credential shapes, and `ac history forget` deletes by session, project or date. Turkish matching is diacritic-insensitive in both directions: `unicode61` folds every Turkish letter except `ı` (U+0131), which is a distinct letter rather than a diacritic-bearing `i`, so every query token is additionally expanded over the dotted/dotless axis. Before that expansion `calisiyor` found 138 of the 1,896 hits `çalışıyor` found; both now return 2,013. The archive also declines to index the search tool's own calls, so searching does not pollute the corpus being searched.
- `ac history index`, `ac history search` and `ac history forget`, the same engine behind a terminal front end for warming, debugging and deletion.

### Removed

- `call-external-agent`, which dispatched a prompt to a local `codex`, `gemini` or `opencode` CLI. The tool and its child-process supervision are gone rather than deprecated, along with `external-agent.ts`, its test file, its shutdown hook and its sentence in the server instructions. The plugin's local surface is now the two tools that read this machine's own state, `web-fetch` and `search-history`, plus the proxied kodizm surface.

## [0.10.1] - 2026-08-04

Repairs nine citations in shipped files that pointed at paths no installed copy of the plugin can reach.

### Fixed

- Both orchestrator bodies, `slug-derivation.md`, and both hooks cited `docs/skills.md:298-300` and `docs/hooks.md:692` for the compaction budget and the additionalContext phrasing rule. Neither file has ever existed in this repository: the anchors were meant for the pinned CLI clone under `references/`, which is gitignored and local, so the citation was dead for every install and not only after a cleanup. They now point at `https://code.claude.com/docs/en/skills.md` and `https://code.claude.com/docs/en/hooks.md`, matching the convention the creator skills already use, and each site states the fact inline so the URL is provenance rather than a dependency. The 5,000-token claim was re-verified against the live page before the swap.
- `global-claude-md-section-template.md` justified keeping its dev-server bullet by citing a line in a local slot map. The maintainer note now states the reason (the built-in's twin sits in a block that renders conditionally on the output style keeping coding instructions) without an anchor only this machine could resolve.

### Removed

- The repository's local `docs/` directory, 14 files of May-era design notes and mitmproxy captures. It was gitignored and untracked, so nothing about this reaches a clone. Eleven of the files had no inbound reference at all; the four that did were consumed only by the two personal CLAUDE files, whose facts are now inlined: the wire-envelope block ordering, the three `system[]` shapes and which scenario lands on each, and the conditional-block warning that a memory file depends on. The ordering is recorded as durable and the tool inventories as indicative, because the captures were three months and eighty-plus CLI versions old and their deferred-tool list no longer matches a real session.

## [0.10.0] - 2026-08-04

Cuts what a plan run costs without cutting a verification layer, after measuring one 14-step complex plan from `/ac:plan` to its final review: 310 minutes, 371M cache-read tokens across 1,570 model turns, and a main-thread context that climbed from 258k to 991k before auto-compaction caught it.

### Changed

- Layer A ran the project's whole test suite once per step. Measured on a 1,507-test Laravel suite that is 25 full runs and 29.8 minutes, at 71.5 s each, while the same step's own test paths finish in 1.3 to 2.0 s. The workers were already doing the right thing (zero full runs, 80 scoped runs across 14 spawns); only the orchestrator was not. Layer A now runs the step's scope, the full suite runs once per wave at the 2f barrier and once at Phase 3a, and the skill says outright not to re-run a check that already passed.
- Neither orchestrator had an output-length target while all four reviewers had one. Opus 5 runs longer by default and effort is not the lever for it, which `prompt-writer/references/opus-5-tuning.md:23` already said. One run wrote 441k output tokens over 364 turns, and every one of them stays in context to be re-read as cache on each later turn. Both skills now carry a per-turn target in their standing-rules block, where a compaction cannot truncate it away, and the four worker bodies carry a token budget of 200 to 600 words by tier.
- The six read-only agents now deny the `Agent` tool. They had it, and they used it: `ac:oracle` spawned an `ac:explore`, `ac:librarian` spawned another `ac:librarian` for 13 minutes, and `ac:plan-code-deep-review` spawned two `general-purpose` agents that ran 5 and 7 minutes inside a 16-minute review. Nobody budgeted any of it, because the docs said it could not happen.
- The code reviewers were told not to report MINOR findings or anything under confidence 50. That is the exact anti-pattern `opus-5-tuning.md:139` warns about, and the run showed its cost: `ac:plan-reviewer-deep` needed three passes, and its third pass found three CRITICALs on the plan's centre of gravity that the first two had every chance to name. Reviewers now report every defect with a severity and a confidence, and the orchestrator ranks and filters at Phase 3c. No verdict rule changed, so opening the reporting channel cannot make BLOCKED more likely.
- `ac:plan-reviewer` gains a `Non-blocking observations` channel, because its verdict rule rejects on any blocking issue and telling it to report everything through one channel would have meant it never returns OKAY. The channel is uncapped, does not affect the verdict, and deliberately carries no `Fingerprint:` line: the orchestrator compares fingerprint sets across passes to detect a stalled review, and a nit reappearing as a new fingerprint would mask the stall the test exists to catch.
- `ac:plan-reviewer-deep` and `ac:plan-code-deep-review` move from effort `high` to `xhigh`. Both are gates whose miss costs a whole execution, `opus-5-tuning.md:38` names `xhigh` the best setting for agentic work, and `model-tiers.md:32` prices the difference at about 19% more output tokens. `ac:plan-worker-senior` stays at `high`, because it runs many times inside a loop whose output the orchestrator verifies four ways.
- Wave spawns are explicit about running in the background. The old wording paired "in ONE message" with "workers run foreground", and a real run read that as permission to serialize: Wave 1 spawned two independent steps five minutes apart while Waves 2, 3 and 5 ran theirs concurrently and finished faster.
- `plan.md` is revised with `Edit` and never through `Bash`. One run rewrote it 34 times with Python heredocs of 7,000 to 11,000 characters, which spends the old text, the new text, and the script wrapper as output tokens, and skips the one guarantee `Edit` gives you while patching a file you are also reading: it fails loudly when its anchor is not unique.
- The plan template gains a single-file chain rule. Three or more consecutive steps writing the same file, each depending on the previous, is one unit somebody split, and the split pays a spawn, a cold re-read, and a full 4-layer verification per link while the dependency order forbids any parallelism in return. On the measured plan that was 72 minutes, 32% of execution, for three senior steps on one class. `ac:plan-reviewer-deep` Dimension 2.6 now flags it, which the file-exclusive check could not, because the plan declared the chain honestly as an ordered track.
- The plan template also requires a real-seam harness step when the plan's core mechanism crosses a network, IO, subprocess, or multi-row data boundary, and Dimension 2.5 checks for one. Four CRITICAL defects survived 14 steps of per-step verification on the measured plan and surfaced only at the final review, and every one needed a real socket or a multi-row seeded fixture to see. The worst would have published "we reached it normally" for every HTTPS check while sending the target zero bytes.
- `model-tiers.md` carries measured per-step cost for each worker tier. The number worth planning around is that `junior-high` cost more per step than `senior` on both turns and cache read, so effort at `high` on Sonnet 5 bought a longer loop rather than a shorter one. The guidance now says to try `junior` with a tighter briefing before reaching for the tier.
- The wave barrier checks `git status` against the modified-files list before committing. Workers prove a test really fails by patching a source file and restoring it, which is a technique worth keeping; what must not survive is the patch, and the file-scope hook cannot catch it because that hook gates `Edit` and `Write` while a mutation arrives through `Bash`.

### Fixed

- "Subagents cannot spawn other subagents" was wrong, and it was asserted as fact in nine places across the plugin, the project CLAUDE.md, and the rules file. Measured on Claude Code 2.1.221 with `USER_TYPE` unset, three agents spawned children and the session metadata records each with `spawnDepth: 2` and a `parentAgentId`. The pinned reverse-engineered source gates this at `constants/tools.ts:41` and no longer describes the shipped binary, which is exactly the caveat the project CLAUDE.md already gives about that reference. What actually prevents an agent from spawning is its own `tools:` allowlist omitting `Agent`, which is why the four plan-workers and all eight `ac:explore` runs spawned nothing.

## [0.9.3] - 2026-08-04

Teaches the CLAUDE.md template what to do when `Grep` and `Glob` are missing from the tool list.

### Changed

- The research routing ladder named `Grep` and `Glob` as though they were always registered, but Claude Code drops both from the default tool set on every non-Windows host: `searchToolsOptIn` defaults to false, and the opt-in is a CLI flag (`--allowedTools Grep,Glob`), not a settings key. Measured on 2.1.221, a session goes from 35 tools to 37 once the flag is passed. So for anyone who never passed it the instruction pointed at nothing, and the visible failure was an agent stopping to ask for the tools instead of searching. The sentence now covers both cases: when the two are absent, reach for `Bash` with `rg` and `find` rather than asking first.

## [0.9.2] - 2026-08-04

Shrinks the global CLAUDE.md section that `/ac:install` merges, and restores the test gate it had lost.

### Changed

- The shipped section is paid on every main-thread turn, because the merged file reaches the model as a `system-reminder` each turn. `## Web research` and `## Research routing` were 39% of it, so the body went from 10,092 to 8,643 characters (-14%). The GitHub command cookbook moved out to the `github-cli` skill, which costs nothing until it is invoked, and the paragraphs that restated `docs/prompts/system.md` were reduced to what they add on top of it.
- Four clauses were kept or restored after review, each recorded in the template's maintainer notes so a later reduction round does not re-cut them: `dev server plus` in the verification line, `or an unrendered application shell` in the fetch-fallback list, `grep the quote it quoted` in report verification, and the rendered-page carve-out on the `gh` line.
- The `gh` routing reads conditionally now. A flat claim that `gh` is authenticated is an environment fact that goes stale silently and then reads as a false instruction.

### Fixed

- An earlier reduction had left the success check naming no gate beyond `LSP` diagnostics, so a repository whose own CLAUDE.md is silent on tests had no layer asking for them at all. The check names test greenness again, and says to speak up when nothing covers the change.

## [0.9.1] - 2026-08-02

Routes GitHub research through `gh` instead of a fetch tool.

### Changed

- The research guidance had four layers (cached docs, live docs, code search, page fetch) and GitHub fell into the last one, so a repository file, an issue thread, or a release note came back as a small model's answer about the page rather than the page itself. `gh` is a better layer for that source: it returns the bytes, it reaches private repositories, and its core API budget is 5,000 calls an hour against `WebSearch`'s shared session budget. The one scarce call is `gh search code` at 30 an hour, so discovery stays on `web-code-search` and `gh` is spent on reading.
- `ac:librarian` gains the same layer in its own body, since a subagent inherits nothing from the main thread. It probes availability once with `command -v gh && gh auth status` and drops to the fetch layers on a miss, saying so in Notes. Its `TYPE B` fan-out no longer sends `WebFetch` at GitHub permalinks.
- The guidance pins `ref` to a commit SHA rather than a branch, because the librarian is already required to cite permalinks with a SHA and that is the only way the lines it cites stay the lines it read.


## [0.9.0] - 2026-08-02

Rebuilds the planning and execution system around a question the previous release could not answer: the two orchestrator bodies had grown to 776 and 673 lines against the project's own 500-line rule, and only 31% of each was landing inside the 5,000-token window a re-attached skill keeps after a compaction. Measured against the closest comparator, oh-my-opencode v4.19.3, which does the same job in a 99-line planning body and a 195-line execution body.

The survey that drove it also settled what to keep. Across eleven comparable systems (spec-kit, Kiro, BMAD, Task Master, Cline, Roo Code, SuperClaude, ruflo, Codex, Cursor, humanlayer), none has a mandatory pre-implementation reviewer with binding reject authority over a plan. That is this plugin's one genuinely differentiating property, and it is lighter than the comparator's five-reviewer gate, so the weight was never in the verification layer.

### Added

- `ac review-counters`, replacing an awk one-liner that was duplicated verbatim in both skill bodies. Prints `ITER PREV GATE NEW` off an append-only log. The `NEW` field counts fingerprints a review pass introduced that the previous pass did not, which is what lets a stall test ask whether a reviewer is converging rather than comparing bare issue counts.
- `ac plan-scaffold`, which writes the plan skeleton with every section heading in template order, so the order cannot drift and a resumed run cannot clobber a filled-in plan.
- A closed-enum `Fingerprint` line in all four reviewer output contracts, with the matching `Fingerprints:` producer in both skill bodies. Free-form phrasing never enters the key, because wording drift would make every pass read as new.
- `ac:plan-worker-junior-high`: Sonnet at high effort, for junior-shaped work at the borderline of coupling or context depth. It is what makes Anthropic's "tuning effort is often a better lever than switching models" actionable, since the routing table previously hard-coded one effort per tier and left the planner no knob but the tier.
- A research verification rule in the global CLAUDE.md template and in the plan skill: a subagent report is a claim, not a finding, and load-bearing claims get checked against the source before they move a decision. Refuted claims are recorded. This release found three of its own reports wrong by applying it.
- A plan-splitting rule in `plan-template.md`, with an explicit statement that the plan file itself carries no size budget. Above 20 steps or 6 waves a plan becomes a sequence, because the binding constraint is review coverage rather than tokens.

### Changed

- `plan/SKILL.md` 776 to 499 lines, `execute/SKILL.md` 673 to 482. Content moved into six references that load on demand; nothing that gates a decision left either body, and `## Standing rules` stays inside the compaction window.
- Both reviewer pairs read one shared reference each instead of carrying their own copy. The duplication was self-admitted ("Identical to `ac:plan-reviewer`", "Stages 1-4 are identical"); the four bodies shed 246 lines between them and identity still selects depth, with no body branching on it.
- The criticality rule closed its predicate. It escalated on "security-critical or correctness-critical" while enumerating only six security surfaces, so the adjective was unbounded and had been lifting two-file edits and markdown restructures to Opus. The list is now declared closed, with a counter-example excluding prompt and documentation authoring.
- The complexity classifier retired `simple` and narrowed `complex`. `simple` was dead by construction, requiring all of five narrow conditions against any of five broad ones, and was never once produced across 13 historical plans. Criticality is now a `complex` predicate, so a two-step auth change no longer gets a single approval-biased reviewer.
- Blocking-issue caps scale with plan size (`3 + steps/10` standard, `5 + 2*steps/10` deep). A fixed cap meant review coverage per step fell as plans grew.
- Review iteration cap 5 to 3, with the stall test firing on a pass that introduces no new fingerprints. No source justifies five; the literature puts most of the gain in the first two passes.
- Both skills drop `effort: max` to `xhigh`. The published Opus 5 curve puts `max` within noise of `xhigh` at higher token cost.

### Fixed

- An empty `Fingerprints:` line made the next pass report zero new findings, firing the stall gate while that pass's findings sat unaddressed. A pass that logged nothing has not said it introduced nothing.
- Fingerprints rendered inside markdown tables carry an escaped pipe and backticks, so the same finding logged from a table and from a bullet were different keys and the new-finding count could never settle.
- `references/` are independent local clones, not git submodules. `CLAUDE.md` had said otherwise, which mattered because it changes what updating one costs.


## [0.8.0] - 2026-08-01

Hardens the plan and execute pipeline against a real failure: mid-run, after a genuine auto-compaction and three further waves of completed work, the orchestrator declared that its memory had filled up and told the user to resume in a new chat. No context-limit event or warning preceded it, and it retracted the reason and kept working as soon as the user pushed back. Transcript forensics also showed the reviewer stall gate never firing across five passes that returned 5, 5, 5, 5, 4 blocking issues, with the rule's full text in context at the time.

The lesson driving this release: a limit written in prose is not a limit. The caps and the terminal branches now live in a hook and in shell commands whose output the model reads.

### Added

- `Stop` hook (`plugins/ac/hooks/stop-guard.sh`) that refuses a turn end while an `/ac:execute` run this session owns is still in flight, returning the outstanding step count and the next unchecked step. Block counter in `.ac/state/stop-guard.json`, incremented by the hook rather than the model, budget 10 with `AC_STOP_GUARD_MAX_BLOCKS` to override. Latches once spent, so it can never strand a user. Shape follows Anthropic's own `plugins/ralph-wiggum/hooks/stop-hook.sh`.
- A `## Standing rules` block at the top of both workflow skill bodies, inside the first 5,000 tokens that survive a compaction (`docs/skills.md:298-300`): turn termination, the context policy, the marker-deletes-before-halt contract, disk-derived loop bounds, and task-list discipline.
- `.ac/plans/<slug>/review-log.md`, an append-only record of every Phase 3 revision pass. The loop reads its own bounds back out of it.
- A "Staying on the task" section in the generated global CLAUDE.md, covering what to do instead of stopping and that a context announcement does not discharge the task.
- `note` field on the active-execution marker: a one-line resume hint the SessionStart hook reads back after a compaction.

### Changed

- Reviewer loop counters are read off disk, not carried in working memory, and the max-iter and stall verdicts arrive as the output of a shell command rather than as inequalities the model evaluates. Both logs are scoped to the current run by a `## Run` header, so a second run on the same slug can no longer count the previous run's passes and skip review entirely.
- Auto mode is set only by the literal `--auto` flag or the Stage 4 pick. An auto-mode intention stated in the topic prose now only decides which option carries `(Recommended)`, so the one gate where the user sees whether the run is autonomous always fires.
- The SessionStart hook names the plan the marker points at instead of the first plan directory with an unchecked step, and reports step counts, the marker note, recent commits, and, after a compaction, what compaction did to the skill bodies.
- All three marker-reading hooks confirm ownership by `session_id` rather than `pid`, and resolve the project tree by probing the payload `cwd` before the stable root, which is what a worktree session needs.
- Task list is one entry per wave plus the phases, slug-prefixed, created after a `TaskList` call.
- Worked examples moved out of the skill bodies into `plan/references/slug-derivation.md` and `execute/references/cross-file-review.md`.

### Fixed

- The executor was told to run `/compact` as its context lever, which the model cannot do: `commands/compact/index.ts:5` marks it `type: 'local'` and `tools/SkillTool/SkillTool.ts:421-427` rejects any command that is not prompt-based. Under context pressure the only remedy on offer did not exist.
- `TaskList` was required by the new task rule but missing from both `ToolSearch` select strings.
- Every em-dash and en-dash removed from the plugin (182) and from the CLI source comments (19), per the project's prose rules.

## [0.7.0] - 2026-07-31

### Added

- The global CLAUDE.md section template rebuilt as a working-discipline contract in eleven
  sections, replacing the previous procedural list. New material: an intent-routing table that
  maps request surface form to intent to route (read, explore, reproduce, plan, end-to-end) with
  per-turn reclassification; a grounding section that forbids speculating about unopened code and
  requires a source for version-sensitive external claims; an ask-or-resolve section built on the
  factual-versus-intent split, so factual gaps get resolved by reading and only preference or
  intent gaps become an `AskUserQuestion`; research routing with explicit stop conditions and an
  anti-duplication rule; delegation bounds; a plan-versus-direct rule; and three-way web routing.
  Sourced from Anthropic's Opus 5 prompting guidance, its Constitution and trustworthy-agents
  research, the `AskUserQuestion` tool's own guard text, `oh-my-openagent`'s sisyphus orchestrator,
  and the Forrest Chang distillation of Karpathy's agent-coding failure modes.
- A `## Project memory` section covering the auto-memory directory from both ends: consult it
  before starting work, and record learnings as they happen. Scoped to what the built-in system
  prompt leaves implicit rather than restating it, so it covers the two mechanical facts that
  change behavior: only `MEMORY.md` (first 200 lines or 25KB) reaches context at session start
  while the topic files it indexes do not, so a relevant pointer is a file to open; and the index
  truncates at its cap, so a low-value entry evicts a useful one. The format, the four entry types,
  and the index convention are already in the built-in and are not repeated.
- Two carve-outs the Claude Code 2.1.220 build no longer provides in its own system prompt, and
  which the template therefore now carries: user-visible verification before reporting completion
  (start the dev server and walk a UI change, exercise a CLI, call an endpoint) and a security
  re-read for injection, traversal, and authorization mistakes.
- Ask-question robustness rule: state the assumption you would proceed on alongside the question,
  so a question that auto-closes leaves a recorded decision rather than a fresh guess.

- The three authoring skills that the model could never reach are now model-invocable:
  `ac:skill-creator`, `ac:command-creator`, and `ac:agent-creator` no longer set
  `disable-model-invocation: true`. That flag is a hard block, not a soft preference
  (`tools/SkillTool/SkillTool.ts:412-415` refuses the call with "cannot be used with Skill tool
  due to disable-model-invocation"), and the flag's own documented purpose is irreversible side
  effects such as deploy or commit. Authoring a markdown file is neither, so it was mis-applied.
  These skills now fire on their own when that kind of work comes up, and they can be preloaded
  into a subagent, which the flag also prevented.

### Fixed

- `/ac:install` was silently broken. Phases 1c and 2c both call
  `Skill({skill: "ac:skill-creator"})` to generate the operator's `my-coding` and `my-language`
  skills, but `ac:skill-creator` carried `disable-model-invocation: true`, so the Skill tool
  refused both calls. Removing the flag repairs the install path.
- All eight skill frontmatter blocks now parse as strict YAML; previously five of eight did not.
  Claude Code parses frontmatter with a real YAML parser (`utils/frontmatterParser.ts` imports
  `parseYaml`), and a colon followed by a space inside an unquoted scalar reads as a mapping
  indicator. `ac:plan` and `ac:execute` additionally had unquoted `argument-hint` values whose
  square and angle brackets read as flow syntax. The values are unchanged, only quoted. The
  parser tolerates the malformed shape today, so this is hardening rather than a live bug fix.
- Trigger-surface bloat trimmed across the five authoring skills. `description` plus
  `when_to_use` went from 8792 to about 6600 characters total. Two skills sat within single
  digits of the 1536-character per-skill truncation cap (`command-creator` at 1530,
  `agent-creator` at 1508), where any edit would have pushed their trigger phrases past the
  cutoff and out of the selection decision. Descriptions are now front-loaded and roughly half
  their previous length, which both improves the trigger decision and reduces what every session
  pays for the always-loaded skill listing.

### Removed

- Verification and double-check instructions are deliberately absent from the template. Opus 5
  self-verifies, and Anthropic documents that explicit verification instructions "cause
  over-verification on Claude Opus 5, and removing them reduces wasted tokens with no loss in
  quality". The grounding section covers the underlying requirement instead.
- Restatements of the built-in system prompt. Verified present in 2.1.220 and therefore omitted:
  dedicated tools over shell, parallel tool calls, `file:line` citations, reversibility and
  blast-radius confirmation, faithful reporting, scope fidelity, and the ambiguity-is-a-judgment
  call. The repo's slot map at `docs/prompts/system.md` documents 2.1.138 and is 82 versions
  behind; the omission list was re-derived against the live build, not that map.

- The `my-workflow` skill scaffold. `/ac:install` no longer generates a separate workflow skill
  and `references/workflow-template.md` is gone. The discipline moved back into the global
  CLAUDE.md section the command merges, because CLAUDE.md reaches every main-thread turn
  unconditionally while a skill body loads only when the model chooses to load it. That is the
  wrong reliability profile for standing procedural rules, and it reverses the 0.6.0 split.
  Phase 2.5 is deleted; its placeholder interview moved into Phase 3a and now fills three
  angle-bracket slots (end-to-end trigger words, real-world-test tools, optional stack line).
  Phase 0b still detects a pre-existing `~/.claude/skills/my-workflow` and reports it as a
  redundant legacy copy rather than deleting it.
- The `opencode/` directory (agents, plugins, append-prompt, README, manifests). Nothing
  referenced it: the live `~/.config/opencode/opencode.json` loads `oh-my-openagent` from npm,
  talks to kodizm directly rather than through the ac CLI, and reads skills from
  `~/.claude/skills`, and the symlinks its README described were never in place.

### Fixed

- Dead cross-references cleaned up. `plugins/ac/commands/work.md` and
  `plugins/ac/commands/plan.md` were removed when the plan/execute pipeline became skills, but
  three files still cited them: `init-project.md` References, `.claude/rules/ac-plugin.md`, and
  the shipped workflow template (which promised users a `/ac:work` command that does not exist).
  All now point at `install.md:20-24` or are gone.
- `@path` import depth corrected in `ac:claude-md-rules-creator`. It said 5 hops; the real limit is
  four. The loader's `MAX_INCLUDE_DEPTH = 5` (`utils/claudemd.ts:537`) is an exclusive bound on a
  zero-indexed depth (`:630`), so levels 0 through 4 process and Anthropic's docs state the same
  limit as "a maximum depth of four hops". Both sources agree once the off-by-one is accounted for.
- `.claude/rules/ac-plugin.md` corrected on two agent-frontmatter claims. It said `tools` and
  `disallowedTools` are mutually exclusive; the loader in fact applies the denylist first and
  then filters by the allowlist (`agentToolUtils.ts:145-160`), and the plan-worker agents use
  both. It also omitted `skills:` and presented `omitClaudeMd` as a supported plugin-agent
  field, which the pinned source does not parse from markdown frontmatter.

### Changed

- Retargeted the whole authoring layer from Opus 4.8 to Opus 5 (`claude-opus-5`, released
  2026-07-24). `prompt-writer` and `skill-creator` each gained a rewritten
  `references/opus-5-tuning.md` replacing `opus-4-8-tuning.md`, and the five creator skills
  (`prompt-writer`, `skill-creator`, `agent-creator`, `command-creator`,
  `claude-md-rules-creator`) now state Opus 5 as the target. Two 4.8 defaults inverted and
  are now documented as inversions rather than silently carried forward: verbosity runs
  longer by default and effort no longer shortens it, and subagent spawning is higher by
  default so 4.8-era fan-out encouragement now overtriggers. Thinking is on by default,
  `{"type": "disabled"}` returns 400 above effort `high`, and Opus 5 can widen task scope
  and over-verify, so the scope guidance now names an upper bound as well as a span.
- Model tier reference rebuilt on primary system-card figures: Opus 5 SWE-bench Verified
  96.0% / Pro 79.2% / FrontierBench v0.1 44.4%, Sonnet 5 85.2% / 63.2% / 17%. Sonnet 5's
  previously unresolvable SWE-bench Verified is now sourced. Terminal-Bench was dropped from
  the table because the harness changed twice in one generation (Terminus-2 to
  mini-SWE-agent, then Terminal-Bench 2.1 to FrontierBench v0.1), making cross-model
  comparison invalid.
- Tier heuristic reversed direction from 0.6.1. The Opus-to-Sonnet gap on the hardest cases
  widened from about 6 points to about 16 on SWE-bench Pro (27 on FrontierBench v0.1), and
  the Terminal-Bench result that justified favoring Sonnet was measured against Opus 4.8 on
  a retired harness. Sonnet 5 stays the default on speed and cost but is no longer described
  as near-Opus, and the criticality-escalation rule is reframed as a cost-asymmetry judgment
  since no published benchmark isolates self-verification on security-critical code.
- Senior tier now routes to `claude-opus-5` in `model-tiers.md`, `plan-template.md`,
  `execute/SKILL.md`, and the `ac:plan-worker-senior` body.

### Fixed

- Documentation URLs migrated off the retired `docs.claude.com` host. API and model pages
  moved to `platform.claude.com/docs/en/`, and Claude Code pages to `code.claude.com/docs/en/`
  which `platform.claude.com` does not serve at all. Three pages were also renamed upstream
  (`adaptive-thinking` to `thinking-steering-and-cost`, `models-overview` and `system-prompts`
  folded into other pages). All 25 distinct URLs across the plugin now return HTTP 200.
- `ac:plan-worker-quick` no longer declares `effort: low`. Haiku 4.5 is absent from the
  effort-supported model list, so the field was inert at best; the routing tables now record
  the parameter as unsupported on that model rather than naming a level.

## [0.6.1] - 2026-07-14

### Changed

- Model-tier reference refreshed with 2026-07 benchmarks and commentary: added a
  Terminal-Bench column (Sonnet 5 leads Opus 4.8, 80.4% vs 74.6%), marked the Haiku 4.5
  SWE-bench Pro cell "not reported", replaced the unverifiable Sonnet 5 SWE-bench Verified
  figure with a sourced confidence note, and tuned the tier decision heuristic to favor
  Sonnet 5 as the default workhorse, reserving Opus 4.8 for genuinely cross-layer,
  long-horizon, or critical work.

## [0.6.0] - 2026-07-10

### Added

- `my-workflow` bundled seed template shipped inside the plugin, so `/ac:install` can
  scaffold a personal workflow-discipline skill (operating mode, code-lookup ladder,
  investigation and reproduction, verification and done criteria, delegation routing,
  and web-tool fallback) alongside `my-coding` and `my-language`.
- Plan-mode `PreToolUse` hook (matcher `EnterPlanMode|ExitPlanMode`) that steers native
  plan mode toward `/ac:plan`, failing open on any parse uncertainty. `permissions.deny`
  stays the load-bearing block; the hook adds the steer.

### Changed

- `/ac:install` reworked to reproduce an operator's full setup on a fresh machine: a
  Phase 2.5 `my-workflow` scaffold, a lean CLAUDE.md delegation pointer merged between
  `ac:delegation` fence markers (procedural discipline now lives in the `my-workflow`
  skill), and a Phase 4 settings merge grouped into safe-silent tuning (Group A, set only
  when absent), core ac parity (Group C), and security-sensitive opt-in keys (Group B,
  default off), plus an interactive MCP-token prompt whose value is masked in every
  rendered surface. Secrets and machine-personal values are excluded from every bundled
  default.
- Global CLAUDE.md delegation section template slimmed to a fence-wrapped pointer; the
  procedural ladders moved into the `my-workflow` skill for token savings.
- Marked the `/ac:install` command non-model-invocable and dropped a superseded Opus 4.6
  reference from the prompt-writer tuning note.

### Fixed

- Remote connection failures in the docs-tool passthrough now normalize to `isError: true`
  instead of throwing a dispatch error, so an unreachable kodizm remote degrades gracefully
  (`ensureConnected()` moved inside the `callTool` try/catch).
- Version drift in the plugin manifest: `plugin.json` was left at 0.4.2 through the 0.5.0
  release. The version is now synced across the marketplace manifest, plugin manifest, CLI
  package, CLI bundle, and the CLI `--version` string.

## [0.5.0] - 2026-07-10

### Added

- MCP proxy alwaysLoad metadata injection for three core research tools: `search-docs`,
  `resolve-library`, and `web-code-search` now load upfront in tool discovery without
  requiring explicit tool search, reducing latency for research-heavy workflows.
- MCP server instructions (2KB budget) providing session-start guidance on the proxy's
  doc/OSS research routing and fallback logic.
- isError normalization on remote tool failures: docs-search tool network errors and
  rate-limit failures now return `isError: true` instead of empty results, signaling
  upstream issues to the model for graceful fallback handling.
- Plugin hooks for session and tool-use gating: `SessionStart` hook displays the active
  plan's next unchecked step; `PreToolUse` hook agent-gates file edits to keep worker
  writes within the active execution wave, with fail-open semantics for safety.
- Layer-3 QA rubric for execute: refined reproducer-validity checks (runnable via one
  command, fails on HEAD, deterministic across runs), evidence-not-assertion reporting,
  and browser-as-human-user walks for UI-touching steps.
- Advisory coverage and Nyquist verification fields in plan templates and reviewers:
  requirements-to-steps coverage percentage (advisory, not auto-blocking), and a
  sub-60-second verify command per step (MISSING steps scaffolded to Wave 0).
- Wave-barrier re-grounding in execute: after each wave completes, re-read the plan
  file and wisdom to sync orchestrator state, enabling clean resume and
  multi-session iteration without context bloat.

### Changed

- Model tier references throughout the codebase updated to Sonnet 5: plan routing,
  tier tables, and prose guidance now reflect Sonnet 5's 85.2% SWE-bench Verified
  and 63.2% Pro benchmarks, with corrected Opus 4.8 numbers (88.6% / 69.2%).
- Execute skill now writes and maintains `.ac/state/active-execution.json` marker
  during plan execution, enabling the PreToolUse hook to scope worker edits to the
  active wave and prevent out-of-scope mutations.

[0.8.0]: https://github.com/anilcancakir/claude-code/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/anilcancakir/claude-code/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/anilcancakir/claude-code/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/anilcancakir/claude-code/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/anilcancakir/claude-code/compare/v0.4.2...v0.5.0
## [0.4.2] - 2026-06-17

### Fixed

- `ac:librarian` direct-page-fetch step no longer frames the ac web-fetch as a guaranteed
  path; aligned with the fallback-only steering applied elsewhere in 0.4.1. librarian is the
  highest-traffic agent and `omitClaudeMd`, so only its body and the tool descriptions reach it.

## [0.4.1] - 2026-06-17

### Fixed

- Built-in-first web routing now actually holds. The 0.4.0 prose steering was
  overridden because Claude Code's own built-in WebFetch description tells the model
  to prefer a registered MCP web-fetch tool, and the ac web tools are directly callable
  while the built-ins are deferred behind ToolSearch. The ac MCP `web-fetch` / `web-search`
  tool descriptions are now marked `FALLBACK ONLY` (prefer the built-in first; use these
  only on error, rate-limit/block, empty or auth-walled content, or an unfollowable
  redirect), which reaches every agent including `omitClaudeMd` subagents at tool-selection
  time. `librarian` and `oracle` bodies no longer frame the ac tools as the friction-free path.
- `resolve-library`, `search-docs`, and `web-code-search` descriptions are unchanged
  (no built-in equivalent; they stay primary).

## [0.4.0] - 2026-06-14

### Changed

- Web tool routing inverted: built-in `WebFetch` and `WebSearch` are now the primary web path
  on the main thread and inside the `ac:librarian` and `ac:oracle` subagents, with the ac MCP
  `web-fetch` / `web-search` as a fallback when the built-in errors, returns empty or
  insufficient content, or hits an unfollowable redirect.
- `/ac:install` no longer denies or hooks the built-in `WebSearch` / `WebFetch`; it
  allow-lists them and strips any web deny or hook a prior install version added.
- `resolve-library`, `search-docs`, and `web-code-search` remain primary ac MCP tools.
- `/ac:install` now applies two web-tool hang mitigations: it sets `skipWebFetchPreflight`
  (removes the per-fetch `api.anthropic.com` preflight, a hang source now that built-in
  `WebFetch` is primary) and sets `API_TIMEOUT_MS` to 120000 when absent. Claude Code has no
  tool-scoped web timeout (anthropics/claude-code#34565), so these are the only available levers.

## [0.3.0] - 2026-06-11

### Added

- `/ac:install` command: interactive setup that writes a personal `my-coding` skill,
  a `my-language` skill, and bootstraps the global CLAUDE.md with operating rules.
- Bundled style and CLAUDE.md templates shipped inside the plugin for `/ac:install` to copy.

### Changed

- Operating-mode overlay migrated from the project-level overlay file into the global CLAUDE.md,
  so the rules apply to every project without a per-repo setup step.
- Agent, skill, and command bodies tuned for Opus 4.8 (clearer identity sections, tighter
  output contracts, updated model routing hints).

### Removed

- `subagent-monitor` plugin removed from the marketplace; functionality superseded by
  the plan-chain agent reviewers.

[0.10.1]: https://github.com/anilcancakir/claude-code/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/anilcancakir/claude-code/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/anilcancakir/claude-code/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/anilcancakir/claude-code/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/anilcancakir/claude-code/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/anilcancakir/claude-code/compare/v0.8.0...v0.9.0
[0.4.2]: https://github.com/anilcancakir/claude-code/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/anilcancakir/claude-code/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/anilcancakir/claude-code/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anilcancakir/claude-code/compare/v0.2.0...v0.3.0
