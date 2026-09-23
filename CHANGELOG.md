# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.24.0] - 2026-09-23

Retargets the plugin at Claude Opus 5.5 on Claude Code 2.1.280. Three facts drove it. `model: opus` now resolves to Opus 5.5, whose effort labels do not port from Opus 5 (its `medium` matches Opus 5's `high`) and which receives none of the Opus 5 prompt bundle, so the host no longer damps delegation or carries `# Delivering work`. The global CLAUDE.md reached the model unsoftened, and a saved `CLAUDE_AFK_TIMEOUT_MS` was auto-submitting questions despite `askUserQuestionTimeout: "never"`. And an audit of every "devam et" nudge since 2026-08-01 found about 190 needless turn endings against 6 real blockers, most of them outside `/ac:execute` and `/ac:auto`, where the marker guards never armed.

### Added

- `stop-guard-announce.sh`, a Stop hook for every interactive main-thread session. It blocks a turn that ends on an announced step with no tool call, an offer to continue, or a question asked in prose, and names the three legitimate endings instead. It reads only the last paragraph of `last_assistant_message`, drops fenced and inline code, lets credential and physical handoffs through, allows the stop while a background task or cron will wake the session, skips `claude -p`, and stops after 2 blocks per stall and 4 per prompt. `AC_ANNOUNCE_GUARD_MAX_BLOCKS=0` turns it off. Replayed against the 224 audited stops it catches 157.
- `prompt-writer/references/opus-5-5-tuning.md`: the Opus 5.5 deltas over Opus 5 (effort default `medium`, thinking that cannot be disabled, forced `tool_choice` rejected, 128k `max_tokens`, thinking blocks bound to an unchanged prefix, unattended early stops, elapsed-time signals, pasted content, `reasoning_extraction` refusals) and what Claude Code 2.1.280 gives 5.5.
- `claude-code-builtin-prompts.md` in both `ac:prompt-writer` and `ac:claude-md-rules-creator`: the verbatim 2.1.280 system prompt text per shape and model, the per-model bundle sections, the CLAUDE.md wrapper as the model sees it, the subagent defaults, and the patterns worth copying. Both skills check a new line against it before writing.
- `/ac:install` writes `askUserQuestionTimeout` and `dialogExpiry` as `"never"`, `CLAUDE_CODE_RETRY_WATCHDOG=1`, `CLAUDE_CODE_THRIFTY_SONIC=0` and `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1`.

### Changed

- `ac:oracle` is a review-first agent with a short advice mode. It quotes the load-bearing claims, tests each against the primary source, reviews by artifact type, classifies candidates as CONFIRMED, PLAUSIBLE or DISMISSED, and reports Coverage, Premises, Findings with a scenario and a fix, Bottom line and Confidence. `/ac:plan` and `/ac:execute` route its REFUTED premises and PLAUSIBLE findings.
- The generated global CLAUDE.md is rebased on the Opus 5.5 lean prompt: lines the host already carries are cut, `Decisions` sends every blocking choice through `AskUserQuestion`, `Run to completion` names the measured stall shapes, an outward action the request names is authorized, a multi-file or hard-to-reverse change goes to `ac:oracle` before it is reported done, and work past a couple of steps starts from a numbered list the user can see.
- Every skill, command, agent and MCP tool description follows Claude Code's own style, and the creator skills teach it: an imperative verb, one "Use when" sentence, one boundary, no mechanics. Description and tool text drops by about 4,200 characters, about 2,700 of it on every main-thread turn. The proxy now owns the five remote tool texts, which also fixes two references to tools it never exposes.
- Agent effort retuned for Opus 5.5: `ac:oracle` and `ac:plan-code-review` `high`, `ac:plan-worker-senior` and `ac:plan-reviewer` `medium`; `ac:plan`, `ac:execute` and `ac:auto` run at `high`, `/ac:install` and `/ac:init-project` at `medium`. `/ac:install` no longer writes a top-level `effortLevel`, which newer models ignore.
- `ac:explore` and `ac:librarian` set `omitClaudeMd: true`, honoured on plugin agents since 2.1.271; librarian carries the research rules it used to inherit.

### Fixed

- `/ac:install` wrote `API_TIMEOUT_MS=30000` and `MCP_TOOL_TIMEOUT=60000`, and offered `CLAUDE_AFK_TIMEOUT_MS`, which turns question auto-submit on whatever `askUserQuestionTimeout` says. A value-matched migration rewrites or removes what an earlier install wrote. The OTEL telemetry option is gone; the installer writes no telemetry key.
- `search-docs` now tells the model to retry with the next `resolve-library` match when a library is reported not found. The remote catalog ranks unsynced local entries such as `/lib/laravel` first, and those have failed on every call since at least August; the server-side fix belongs to the remote.
- The `/ac:execute` and `/ac:auto` markers carried a model-written session id and a local time with a `Z`, which left about half of them unarmed. The skills now write `${CLAUDE_SESSION_ID}` and `date -u`, and both guards tolerate the old skew.

## [0.23.0] - 2026-09-04

One real `/ac:plan` run produced a plan that `/ac:execute` could not parse, and lost its own `Lock all?` gate on the way. Both come back to the same thing: a step of a procedure that lives only in prose holds only as long as the model's attention does, and this run was 457K tokens deep with its checkpointing already skipped. So both fixes moved into the deterministic layer. The step shape moved from `plan-template.md`, which the planner never opened, into the scaffold the planner is already editing, with a validator behind it; the Stage 4 answer became a required argument of the command Stage 5 opens with.

### Added

- `ac plan-check <slug|path>` validates a plan file's machine-readable shape and exits 1 on any error: a checkbox count that disagrees with the `Steps` frontmatter, a `Type` outside `code`/`infra`/`verification`, a worker step with no `Tier`, a verification step with no `Commands` or `Evidence`, a missing `Auto mode` line, a scaffold placeholder left in place. It prints the step and tick counts on every exit, including a clean one, because Phase 1g is told to hold them. The error set is exactly what a downstream consumer parses; a field with only a human reader warns instead, since a gate that fires on four correctly written steps teaches its user to skim it. Exit 2 is reserved for a plan file that is not there, which is a different problem with a different fix. `/ac:plan` runs it at Stage 5 before the reviewer spawns and again after the reviewer's last edit, and `/ac:execute` Phase 1g runs it in place of its hand-rolled checkbox grep.
- `ac plan-scaffold` writes a worked step stub under `## Steps` instead of a `<fill>` marker, carrying the `- [ ] **Step N**:` line, the three `Type` values with what each one routes to, and every field the checker requires.
- `ac plan-scaffold --auto-mode <true|false>`, required with no default, recorded in the plan frontmatter as `**Auto mode**:`. Stage 5's first action is this call, so a run that skipped Stage 4 has no value to pass and finds that out immediately; Stage 6a reads the field rather than an in-context variable, so the decision survives the compaction that lost it.

### Fixed

- `/ac:plan` Stage 4's `Lock all?` gate has a forcing function instead of a prose instruction. The gate was skipped once and `AUTO_MODE` was never set for the rest of the run. The obvious explanation, that the preceding render was too long, is wrong and is recorded here so nobody re-derives it: the render was 908 characters, the two Stage 3 renders that carried their questions fine in the same run were 360 and 395, and the planner's own reasoning before the render already said it was moving on to write the plan. The synthesis is still split, with the full text going to `interview-log.md` and a roughly 2 KB chat form carrying only what the user can still change, but that is the cost rule the skill already argued and not a fix.
- `/ac:execute` Phase 1g repairs a plan whose steps are all present but unticked, instead of refusing it. Measured on the plan that prompted this: the repair took a user gate and 18 separate `Edit` calls before the first worker spawned. A plan whose steps are genuinely absent is now reported as truncated and still stops, because the two look identical from the checkbox count alone and the old message steered toward inventing checkboxes for steps nobody wrote.
- An unrecognised `Type` routes on the step's fields rather than blocking. A step carrying a `Tier` is a worker step, since `Tier` is meaningful on nothing else, and a step carrying `Commands` and `Evidence` without one is a verification step; `implementation` is the value this actually produces and it maps to `code`. A worker step missing its `Tier` stays a plan-spec BLOCKER and now explicitly outranks the field-routing rule, because a step reporting both would otherwise be read as a verification step, have its `Commands` run and its box ticked, and never have its code written.
- `plan-check` requires the space after the checkbox bracket that `stop-guard.sh` greps for. Without it the gate would bless a plan whose progress signal the `Stop` guard cannot see, which is worse than having no gate.
- `plan-template.md` listed three worker tiers where four exist, two lines above a rule that routes to the fourth.

## [0.22.0] - 2026-09-04

The generated CLAUDE.md gains a conditional section routing long-running watches to `Monitor`. The section is three sentences because the `Monitor` tool's own description is long, good, and unreachable at the moment the decision is made: the tool sets `shouldDefer: true` and the deferred-tools reminder carries bare names with no search hint, so the description arrives only once the model has already decided to reach for the tool.

### Added

- `## Watching something over time` in the generated global CLAUDE.md, emitted only when the operator has taken the Group D scheduling trim. It carries what arrives before `ToolSearch` and nothing else: that watching is the shape of the work, that there is no cron route, and the one routing decision taken while `Monitor` is still just a name. That decision only goes one way, because routing toward `Monitor` loads its description while routing away to `Bash` with `run_in_background` is the branch where the description never loads.
- `references/monitoring.md`, the depth behind that section: why cron is absent rather than denied, the two worked `Monitor` shapes with every schema-required field present, and the two gates that change what the section means (the `Monitor` feature flag, which defaults off, and the `backgroundTasksDisabled` branch in the tool's own description).
- `/ac:install` Phase 0b detects the trim from `~/.claude/settings.json` rather than asking, testing one key from each of the three claims the section makes. It reads user scope only, because the file being written loads in every project, and it fails closed: a false sentence in a global CLAUDE.md costs more than a missing section.
- Phase 4 gains a step that closes an ordering seam. Group D is answered after Phase 3 has written the CLAUDE.md, so an operator taking the trim in the same run would otherwise get no section; the step re-evaluates the conditional and re-merges through the existing fence markers instead of asking for a second run.

### Fixed

- Two mechanism errors caught in review before they shipped further than one file. `permissions.deny` strips a tool's schema, so a denied cron tool is absent rather than present-and-refused and no turn is spent reaching for it; the draft had borrowed the "costs a turn" clause that `Plan or work directly` uses correctly for `Agent(Explore)`, a rule on a tool that is still present. And a non-persistent `Monitor` is not armed forever: `timeout_ms` defaults to 300000 and caps at 3600000.

## [0.21.0] - 2026-09-04

Two findings drove this release, both measured against the shipped 2.1.260 binary rather than inferred. The lean system prompt shape that Opus 5 receives builds no response-length guidance at all: `# Tone and style` is produced by the classic branch only, and the communication section, present in both shapes, branches internally on a capability Opus 5 does not carry and collapses to one sentence about matching surrounding code. So the plugin now ships an output style and the generated CLAUDE.md carries a one-line floor beneath it. Separately, the skill and agent listings were spending more per-turn context than they earned, and an overflowing listing drops whole entries silently, so every description in the plugin was rewritten as a retrieval surface rather than a summary of its own body.

### Added

- An output style at `plugins/ac/output-styles/concise.md`, selectable as `ac:concise`. It leads with the result, holds a simple answer to one to three sentences, replaces a describing sentence with the artifact that settles the point, and carves out error output, failing tests, security warnings and destructive-action confirmations so brevity never costs correctness. It sets no `force-for-plugin`, so nothing applies it until the operator asks for it. `/ac:install` gains a Group E gate that writes the key, and Phase 5 tells the operator to confirm the result in `/config`: a style value that does not resolve returns null with no diagnostic anywhere in the binary and reads exactly like an unset key. Measured on 2.1.260, a plugin style is addressed as `<plugin>:<style name>`, so `ac:concise` resolves while bare `concise`, `concise@ac` and `ac@ac:concise` all silently do not.

### Changed

- The generated CLAUDE.md asks for two languages instead of one. The conversation language and the artifact language (code, identifiers, comments, doc blocks, commit messages, documents) are independent, which is the Turkish-conversation-with-English-artifacts case the old hardcoded English could not express. Both are collected in a new Phase 0d, before Phases 1 and 2 need them rather than in Phase 3 where they would have arrived too late for the two generated skills. The organisation-override sentence and the language-split bullet are each emitted only when their condition holds, so a matching pair does not ship a bullet explaining a distinction that does not exist.
- The dash rule is scoped rather than absolute. It holds in a finished artifact, meaning a code comment or doc block, a commit message, a PR description, a document, an email, a message to a person, and is free in the conversation and in our own working files. Two clauses keep the carve-out from leaking: the rule follows the content rather than the channel, so a commit message drafted inside a chat reply still takes the hyphen, and anything the model cannot confidently place counts as an artifact. `references/language-style-template.md` is rescoped to match, because leaving it absolute would ship two rules that contradict each other.
- Two `Core principles` bullets now cover answer shape and written-artifact length. On 2.1.260 an Opus 5 session with no output style selected receives no response-length guidance from any built-in block at all, which is wider than the earlier `# Tone and style` finding recorded. That block is built by the classic branch only, and its current four bullets no longer contain the "fewer than 4 lines" and "minimize output tokens" wording an audit would grep for. The communication section is present in both prompt shapes but branches internally on a capability Opus 5's roster does not carry, collapsing to one sentence about matching the surrounding code's style.
- `references/coding-style-template.md` and `references/language-style-template.md` carry the depth behind the two new bullets: doc-block content in the first, document and commit and PR length in the second. The one-line rule stays in the file that always arrives and the explanation stays in the skill that arrives on trigger.
- Every skill, agent and command description in the plugin is now a retrieval surface rather than a summary of its own body. Ten agent descriptions, eight skill descriptions and `/ac:commit`'s were rewritten to carry the trigger and the routing boundary and nothing else, because the listing is loaded on every main-thread turn under a budget of 1% of the context window and an overflow drops entries silently. The facts that left the frontmatter did not leave the plugin: tier routing lives in `skills/plan/references/model-tiers.md` and the `/ac:execute` routing table, the commit split thresholds in `ac:git-master`, and each worker's scope boundary in its own body. `/ac:install` Phase 5 now reports what the operator's listing costs and names `skillListingBudgetFraction` as their lever, and writes no setting for it.
- Every frontmatter `description` and `when_to_use` that needed it is now quoted. A value carrying `": "` or opening with a backtick is not valid YAML; Claude Code's own parser tolerates both, but the documented failure mode for malformed frontmatter is loading the body with empty metadata, which is silent.

### Fixed

- `skills/claude-md-rules-creator/references/layered-context.md` no longer tells an author that "be concise" is already in effect and safe to cut. Five places said so, across the reference and the skill body: the built-in defaults list, the do-not-restate paragraph, the conflict-precedence table, the quick cheat sheet, and stage 9 of the skill itself. All five describe the classic prompt shape and are false on the models this plugin targets, and that reference is exactly what would talk a future maintainer out of the rule above. The cheat sheet carried three further entries with the same defect, so each of the four now reads `[classic only]`.

### Removed

- `plugins/ac/bin/ac`, a five-line bash wrapper that exec'd `node ../cli/ac.js`. Nothing called it: `.mcp.json` invokes the bundle directly, `plugin.json` has no `bin` key, and the plugin manifest schema has no `bin` property for one to hang off. It was also redundant, since the build gives the bundle a `#!/usr/bin/env node` shebang and mode 0755, so `./plugins/ac/cli/ac.js` already runs on its own. Shipped 2026-05-13 and untouched since.

## [0.20.0] - 2026-09-04

`/ac:install` now generates the whole global CLAUDE.md rather than one section of it. The prompt for this was finding that the section template's entire design argument was pinned to a system prompt shape the current Opus models no longer receive. The release also runs `/ac:init-project` against this repository and rewrites every outward-facing surface against measured evidence.

### Changed

- The `ac:delegation` fence covers the whole generated `~/.claude/CLAUDE.md`: role, core principles, identity and coding anti-patterns as well as the working discipline. Those four used to be left to the operator, which meant a new machine never got them. Phase 3's interview grows to four rounds to fill them, and two sections are optional: extra anti-patterns, and a fallback for pages a WAF blocks.
- The section template is rewritten against the system prompt that actually renders. Claude Code assembles the main-thread prompt in a lean shape or a classic one and picks per model, from a capability roster that on 2.1.259 names five models for lean. The lean shape does not build `# Doing tasks` at all, so the OWASP bullet and the dev-server bullet the template defended as conditional duplicates are simply absent, and six further rules go with them. The maintainer notes now argue against the lean shape, carry a four-part keep test in place of the old omit-what-the-built-in-carries rule, and cite the shipped string plus a grep recipe rather than a minified symbol that will not survive a release.
- Every maintainer note is an HTML comment. The memory loader strips those before injecting a CLAUDE.md, so they cost nothing; the `[//]: # (...)` form the template used is a Markdown link-reference definition and ships as visible text.
- Three rules the lean shape drops are recovered at one line each: no guessed URLs, prefer an edit to an existing file, and do not refuse a request for being large. Prompt-injection flagging was considered and left out.
- The pair-programming rule stops contradicting the built-in. It said to push back and wait for approval where `# Delivering work` says to state the concern and keep building. It now splits by risk: stop on hard-to-reverse or outward-facing work, elsewhere name the assumption and finish.
- The security rule is a write-time constraint rather than a re-read instruction, because explicit verification instructions are documented to cause over-verification on the current Opus generation at no quality gain.
- `/ac:install` is half the size. A slash command body renders into the user prompt rather than the system prompt, so it competes with the request the operator actually typed; this one had reached 464 lines and 41KB, of which 175 lines were settings key tables. It is now 282 lines, with every key in a new `references/install-settings.md` that loads only when Phase 4 runs and costs nothing under `--skip-settings`. Nothing behavioural moved: the identifiers that appear to vanish are key-equals-value spans collapsed into table columns.

### Fixed

- The CLAUDE.md merge no longer duplicates the headings it now generates. An operator's own role and anti-patterns sections sit outside the fence, where a marker-to-marker replace never touches them, so an upgrade left the file carrying both copies and saying opposite things. The heading-collision report runs in both writing cases, and matches level-one headings as well as level-two, because the block now opens with one.
- A file with one stray fence marker stops the merge instead of appending beside it. Appending left the marker in place, so the next run read a start before an end and swallowed whatever the operator had written between them.
- The generated `my-coding` skill gets the three anti-patterns the style interview keeps missing. One run produced a thirteen-row table with none of them; they are seed rows now, written whatever the interview surfaced. The language template gains the matching rule in reverse: no author or identity section, because that is a one-line rule belonging in the file that arrives every turn.
- `ac:librarian` may not cite a URL it did not retrieve. No subagent receives either prompt shape, so the rule against guessing URLs reached the agent whose whole output is citations through neither.
- Phase 3 backs the global CLAUDE.md up before rewriting it. Phase 4 has always backed up `settings.json`; the phase that overwrites a file someone has been hand-editing for months backed up nothing.
- The apply gate can replace the whole file. When every heading outside the fence is one the block now generates, none of that content is losable, and reporting the collision as homework left the operator a file that said everything twice. The option is dropped when the collision is only partial, because then the out-of-fence content is content the block does not carry.
- Phase 3 no longer interviews for answers the operator's current file already holds. On an upgrade, identity, language, trigger words, tools and stack are all recorded in the copy about to be replaced, and asking again breaks the generated file's own rule against asking what a readable file already answers. It reads that file first and confirms in one round.
- A placeholder can no longer survive into a live CLAUDE.md. One of the eight occurs twice, so a first-occurrence substitution shipped a raw angle bracket, and nothing checked. A grep now runs before the gate, with the literal `<topic>`, `<slug>` and angle-bracketed email as the expected non-matches.
- An operator's existing optional section is carried forward rather than regenerated. Rebuilding `Blocked pages` from three interview answers would have discarded two measured timings and a failure mode from the section already there.
- Pre-filling the Phase 3 placeholders no longer skips the confirmation. A live run filled the name from two different lines of the same source file and shipped `Anilcan` in `Role` beside `Anılcan` in `Identity`; both sections now come from one string, on either branch, and the confirmation round has a stated shape rather than only a requirement to exist.
- Phase 3 drops the ac MCP fallback sentences when the Phase 0 probe failed. Phase 0 has always promised that and no later step performed it, because the template names those tools as static text with no placeholder to leave empty.
- The stray-marker branch names its two remedies again, and the summary stops carrying an MCP URL that the settings reference owns.
- The marketplace manifest declared a `$schema` that 404s. `https://anthropic.com/claude-code/marketplace.schema.json` does not resolve, so the manifest got no editor validation at all; it now points at the SchemaStore URL that `anthropics/claude-code` uses.
- Both manifest descriptions promised bug investigation "with hypothesis discipline". No such surface ships, and the official directory's own review prompt fails a submission whose install description does not match its behaviour. The descriptions now state what is actually there, hooks included. They carry no component counts: a count in a description goes stale silently, which is how the README came to claim nine subagents, then eleven, against an actual ten.
- The README carried five stale facts: a version badge pinned to 0.9.1, "nine subagents" and "11 subagents" against an actual ten, "8 skills" against nine, and a Node floor of 20 against the real 22.13.0. The hooks and the MCP tools were not mentioned at all.
- `.claude/rules/ac-plugin.md` described frontmatter that had drifted. `allowed-tools` and `disable-model-invocation` were missing from the command shape, `name` was listed as universal on skills when `plan` and `execute` omit it, and `user-invocable` was undocumented. `disable-model-invocation` is the costly one: it keeps a command out of the model's own list, so a plan step that says "run `/ac:install`" cannot execute, and nothing recorded that.

### Added

- `## Golden Rules` in the repository's `CLAUDE.md`, carrying the three rules that have to hold unconditionally. The build-artifact rule moved here from `.claude/rules/cli-build.md` because a path-scoped rule loads only when Claude reads a matching file; `Edit` and `Write` do not trigger one, which is exactly the path where hand-editing the bundle silently loses work.
- `.claude/rules/hooks.md`, scoped to `plugins/ac/hooks/**`. Seven shell scripts had no rule coverage: neither the markdown rule nor the CLI rule matches that directory. It records the `#!/bin/sh` plus `set -u` fail-open shape, the payload facts a gate depends on, and what a restart does and does not reload.
- A required seed list in `coding-style-template.md`, so the three anti-patterns the lean system prompt drops reach every generated `my-coding` skill regardless of what the interview surfaced.

## [0.14.2] - 2026-09-04

A pass over the workflow's own instructions, prompted by finding that several of them had been doing nothing for a while. The theme is that a rule which cannot be executed reads exactly like a rule that is being followed.

### Fixed

- The plan and execute skills no longer build a task list. Twenty-six instructions across `ac:plan`, `ac:execute`, `ac:auto` and `/ac:install` called `TaskCreate`, `TaskUpdate` or `TaskList`, and both `<bootstrap>` blocks tried to fetch them through `ToolSearch` along with `AskUserQuestion`, which is not deferred and was already present. None of it ran: `~/.claude/settings.json` can switch the task tools off, and where it does, every `TaskUpdate Stage N to completed` line is dead text. The progress surface is now the two things that already worked, the plan file's `- [ ]` checkboxes and the Phase 2h table, and Phase 1g checks the checkbox count against the plan's own `Steps` rather than assuming it.
- A plan can no longer name a step the executor cannot perform. `disable-model-invocation: true` keeps a command out of the model's own list, so a step saying "run `/ac:init-project`" was unexecutable as written; the plan template now forbids it and `/ac:execute` checks reachability before a wave launches. Both read the component's frontmatter rather than grepping the file, because several skills discuss the flag without setting it.
- `Done when` criteria are audited for whether they can fail at all. `grep -P` on macOS exits 2 with an empty stdout, so a "returns nothing" gate written that way passes on input it should reject; a pipeline ending in `head` can truncate before the value it asserts; and a criterion naming a number can contradict the fixture its own step prescribes. Stage 5 flags these as `criterion-needs-negative-test` and `ac:plan-reviewer` reports them as CRITICAL.
- The advisory agents' shell constraint says what it meant. `ac:librarian` forbade writes in one sentence and prescribed `gh repo clone` in the one before it; both agents now allow exactly the scratch writes they need under `${TMPDIR}`, name them in the report, and produce no side effect anywhere else.
- Slugs stop filling with Turkish filler. The stopword list was missing the common ones and matched literally, so `projesi` was filtered while `projeye` reached a slug; case suffixes are enumerated, duplicate tech tokens are deduplicated, and the topic that exposed this is a worked example.
- Two hook scripts and `ac:auto` no longer tell the model that a task list mirrors the plan file.

### Changed

- The progress-surface rule moved into the global CLAUDE.md section `/ac:install` merges, so it governs ordinary work rather than only a plan run.
- `ac:prompt-writer` gained a pre-flight item: a fenced command in a prompt body is code, and shipping it unrun is shipping untested code. Written after a shipped recipe turned out to be broken two independent ways, both invisible on reading.

## [0.14.1] - 2026-09-04

### Fixed

- The MCP server no longer dies on Node 18 and older Node 20. The shipped bundle is ESM in a file named `ac.js`, and Node only reads such a file as ESM when the nearest `package.json` says so or when its module-syntax detection is on. That detection is unflagged from 20.19.0 and 22.7.0 only: on 18.x it never existed, and on 20.0 to 20.18 and 22.0 to 22.6 it is off, so `node ac.js mcp` raised "Cannot use import statement outside a module" and the server never started. It worked on the author's machine purely because that machine runs 22.17. The build now emits `plugins/ac/cli/package.json` carrying `{"type": "module"}` beside the bundle, which is the explicit form and works on every Node that supports ESM at all. Reproduced and verified locally with `node --no-experimental-detect-module`, which turns a 22.x runtime back into a 20.18 one: the bundle fails without the manifest and starts with it.

## [0.14.0] - 2026-09-03

The three advisory agents rebuilt on measurement rather than on what their bodies claimed. `ac:oracle` now tests the premises a brief rests on before answering it, because both of its call sites hand it conclusions and an advisor that reasons inside a frame it was handed confirms that frame. `ac:explore` and `ac:librarian` were tuned apart rather than together: across 733 runs the same shape of instruction binds on Sonnet and does not bind on Haiku, so one agent got a harness-enforced call budget and the other got literal counts in its prose.

### Added

- A `PreToolUse` hook caps one `ac:explore` spawn at 60 tool calls, scoped by the `agent_type` the harness supplies. Two frontmatter mechanisms were tested first and neither works on 2.1.259: `maxTurns: 3` did not bind (61 turns ran), and a `hooks:` block in an agent's own frontmatter never fired, though the pinned reverse-engineered docs describe it as supported. What does work was measured directly: a plugin-level hook receives `agent_type` and `agent_id` inside a subagent and neither on the main thread. The cap is calibrated on the tail, never firing on a median 36.6-call run and cutting the 183-call outlier, and it denies with a next action so a tripped budget still returns partial findings with the unfinished angle named.
- Every research brief now carries a `DEPTH` and a `BUDGET` field. Both agents already defined what quick, medium and thorough mean, and across every shipped brief not one passed a value, so the lever existed on paper only. The instruction version already existed and already failed: the global CLAUDE.md says "say how deep to go" on every main-thread turn and no brief carried a hint. A blank field in a template gets filled; a sentence elsewhere telling you to fill it does not.

### Changed

- `ac:oracle` extracts the three to five claims a recommendation turns on and classifies each CONFIRMED, REFUTED or UNSUPPORTED against a primary source, with UNSUPPORTED as the default and a quote required to move a claim in either direction. That polarity is the design: this agent tagged 108 of 119 consultations high confidence and never once low, so a scheme where CONFIRMED is cheap returns all-CONFIRMED. Both callers now pass the sources it checks against, and a refuted premise gets its own branch at `/ac:plan` Stage 3.5c, above the finding severities, because it means the research under a locked decision does not hold.
- `ac:explore` routes by question instead of ranking tools. It named LSP first and used it zero times in 309 runs; it said "prefer Grep over Bash grep" while shell grep ran 1,512 against the tool's 1,489, and a measured comparison finds shell grep is not the wrong choice for agent search. Tool names are now required verbatim, since this agent emitted two calls to tools that do not exist.
- `ac:librarian` keeps its tool ladder, the only one of the three that matched its measured behaviour, and keeps its self-check language, which Anthropic names Opus 5 rather than Sonnet 5 as the exception for. Its stop conditions became counts: two consecutive queries returning no new URL, and five web searches against 13.3 measured and a documented accuracy plateau between three and five.
- The global CLAUDE.md research section drops `ast-grep` (0 calls across 174 sessions), demotes `LSP` out of first place (8 calls, not zero), and states the research procedure as five ordered steps. The step that was missing is asking whether the project already solves it before going outside for an answer.


## [0.13.1] - 2026-09-03

One fix, found from disk rather than from reading: the plan `Stop` guard was retiring itself at the first parallel wave, which is the first thing that makes a run long enough to need it.

### Fixed

- The plan `Stop` guard retired itself at the first parallel wave. Its no-progress test compared the plan's unchecked-checkbox count between blocks, and a wave verifies its steps together at the barrier, so from the first spawn until that barrier the count is pinned by design while several workers are mid-flight. Caught from disk after a real run: the counter read `{"blocks":1,"unchecked":9,"spent":true}` with a budget of 10, meaning it latched on the no-progress branch after a single block at wave 1 of 4 and was inert for the remaining three waves and the whole review phase. The progress signal is now tool activity rather than checkbox movement, which is what the first-party `/goal` loop uses for its own stall detector: the counter stores the transcript's byte size at each block and the next block scans only the bytes added since, costing about 10ms on a 14MB transcript. A payload with no `transcript_path` cannot fire the test at all, deliberately, because an unreadable transcript is not evidence of a stall and the block budget still bounds the run.


## [0.13.0] - 2026-09-03

Adds `/ac:auto`. The plugin could already plan and execute; what it could not do is be left alone, because nothing decided when a run was finished except the model doing the work.

The design came out of finding that Claude Code already ships a first-party answer, `/goal`, whose evaluator judges a condition after every turn. That is not wired in, because `ProposeGoal` is the tool that would let a plugin arm one and it is not exposed at runtime, verified by listing a clean session's tools on 2.1.259. So this ships its own Stop hook and pairs it with the one that already existed, which turns out to be the stronger arrangement: one guard reads plan checkboxes off disk and cannot be talked out of them, the other asks only whether a verdict file exists and never reads whether the work succeeded. Neither is the actor. The literature on autonomous loops is unanimous that an actor authoring its own check produces work that passes with the defects still in it, and every mechanism surveyed still bottoms out in a human-authored check or an iteration cap.

The refusals are the interesting part. It takes no request whose criteria cannot be listed before work starts, because criteria written afterwards are written knowing what got built. It auto-answers no BLOCKER. It never pushes. And the gate holds no tool that can change what it judges.


### Added

- `/ac:auto`, an autonomous mode for the ac plugin that runs a request to completion with a verdict delivered by a read-only gate. The orchestrator (`ac:auto` skill) freezes criteria to `.ac/auto/<slug>/criteria.md` under a sha256 digest before handing work to `ac:plan --auto`, which chains `ac:execute` itself rather than invoking it separately. The gate (`ac:auto-verifier`) runs in a separate subagent with a tool allowlist carrying `Read, Grep, Glob, Bash` and no `Edit`, `Write`, or `Agent`, so it holds no tool that can change what it judges. Two independent `Stop` hooks fire on every turn end and their predicates are deliberately disjoint: `plugins/ac/hooks/stop-guard.sh` asks whether the plan is finished, read from the plan file's step checkboxes on disk, and `plugins/ac/hooks/stop-guard-auto.sh` asks only whether `.ac/auto/<slug>/verdict.md` exists, never reading whether any criterion is met. A block from either beats an allow from the other, and when both block the model receives both reasons. `turn_budget` (default 40) and `failure_budget` (default 0.2, a fraction of total plan steps) both live in the run's `criteria.md`, not in the environment: the run continues while `failed_steps / total_steps` stays within the budget and hard-stops once it exceeds it, so on a 15-step plan three failures (3/15 = 0.20) continue and a fourth (4/15 = 0.27) stops the run. v1 accepts only requests whose success and failure criteria are enumerable before work starts; open-ended audits and multi-phase exploration are refused at Phase 0. The run never pushes: `/ac:execute` Phase 4 now passes `--no-push` to `/ac:commit` whenever `.ac/state/active-auto.json` exists, since an unattended run has nobody present to approve an outward-facing action and `/ac:commit`'s branch guard only asks before pushing on `main` or `master` in the first place. While a run is live, a new `PreToolUse` hook on the `Bash` matcher denies twelve irreversible verbs, among them `git push`, `git reset --hard`, `git clean` and `rm -rf`, and it does not exempt the orchestrator. It is inert whenever no auto marker this session owns is present, so an ordinary session is unaffected. It is a speed bump rather than a boundary and its header says so: quoting defeats it, and everything it denies lands on files a wave checkpoint commit already captured. A BLOCKER is never auto-answered: every interview gate in `ac:plan` Stage 3 and every BLOCKER in either chained skill reaches the user exactly as it would in a supervised run, and `overrides[].accepted_by` is never written by the model.

## [0.12.0] - 2026-09-03

Rebuilds `/ac:plan` and `/ac:execute` around the wave. The old pipeline was designed step by step and priced nowhere, so this release starts from measurement instead: one real end-to-end run at 389 turns and 415k average resident context, 367 worker runs behind the tier table, 88 reviewer runs behind the decision to drop the review loop, and 1,914 plan steps behind the field set.

The measuring found four rules that had never once executed and a fifth that contradicted itself, which is the part worth keeping in mind when reading the entries below. A review loop with a 94% reject rate was not catching bad plans, it was told to report everything and then blocked on the total. An explore floor of four spawned nothing. A re-read layer read nothing. Two escalation rules had no qualifying input in the whole corpus. None of that is visible from the prompt text; it is only visible from the transcripts, which is why `run-stats` and `plan-stats` ship in the same release as the redesign they were built to check.


### Changed

- `/ac:plan` and `/ac:execute` are rebuilt around the wave rather than the step, after measuring one real end-to-end run at 389 turns, 161.7M cache-read tokens and 415k average resident context. The orchestrator now takes one diff, one typecheck, one build, one test run and one commit per wave, issued as a single message. Per-step scoped tests are gone: the wave suite is a strict superset, and the same tests were running scoped per step, again at the barrier, and a third time in Phase 3. The QA scenario and the plan checkbox stay per-step, because the first is the only proof anything ran and the second is what the `Stop` guard reads as its progress signal.
- Layer B reviews the wave diff hunk by hunk instead of re-reading every changed file, opening a full file only on four named triggers. The diff is the stronger instrument against a worker that overstates what it did, because it is the delta against the claim rather than an end state you are asked to compare from memory. Two detectors cover what a diff cannot see: `LSP findReferences` on each new export and one repo-wide grep per new function name, since duplication lives in files nobody was going to open.
- Failure attribution moves from the per-step test to matching diff hunks against the workers' `### Changes Made` claims, by file first. Concurrent workers on a shared file report mutually inconsistent line ranges, so file ownership from the plan is the only deterministic key. An unclaimed hunk also catches a worker writing another step's file, which the file-scope hook permits because it gates on the wave's union.
- Workers no longer open the plan file. The briefing carries the step's pattern references and Reuse Map entries, the full codebase conventions, the Work Objectives invariants and the plan-wide `Must NOT Have` guardrails inline, which is roughly 8k tokens of subagent input per worker that stops being spent re-reading a file the briefing already quotes. Descriptions must now stand alone: 454 of 1,914 in the corpus name a sibling step by number, and a forward pointer has no source to fall back on.
- Plan review is one advisory pass with no verdict and no loop. Measured across 26 plans and 88 reviewer runs it returned 82 REJECT against 5 OKAY, with 69% of plans hitting the 3-pass cap and 27% exceeding it, so about 80% left the loop by hitting the cap and having the operator pick `Proceed anyway`. The 94% reject rate was a self-contradiction rather than a quality signal: the agent was told to report everything and let a downstream pass filter, while its own verdict rule blocked on accumulated findings, so the filter never ran.
- Tier routing is priced from 367 real worker runs instead of one. `ac:plan-worker-junior-high` costs 36.1 turns per step against senior's 58.7, reversing a claim the reference had carried from a single plan, and senior is 5.9x junior per step. The criticality rule now fires when a step DECIDES security-relevant behaviour rather than when it touches a surface, tested by a concrete before-and-after, because "touches" put half of every recent plan's steps on senior.

- Every shipped `description` and `when_to_use` is shorter and now states where the component stops rather than listing the phrasings that should fire it. Eleven agents, eight skills and `/ac:commit` were rewritten. The old shape closed with "Use aggressively; undertriggering is the failure mode", which named a dozen occasions to fire and not one occasion to stay out, and it grew every time a new phrasing occurred to the author. Descriptions load into every main-thread turn whether or not anything invokes them, so this is the one surface where length is paid for unconditionally.
- The advice the plugin gives about descriptions now matches the ones it ships. `ac:skill-creator` and `ac:prompt-writer` taught the pushy shape ("Modern Claude undertriggers, so lean toward catching the request") while `ac` itself had moved off it, so a skill written with these tools came out in a style their own author had abandoned. Both now teach capability plus boundary, and the worked examples and pre-flight checklists were rewritten to match.
- The three local MCP tool descriptions (`search-history`, `web-fetch`, and the `web-search` fallback directive) drop their worked examples and their `ToolSearch` instructions for the built-in tools. Same routing rule, fewer tokens on every call.

### Added

- `ac run-stats <session>` prints the cost anatomy of one run from its transcript: turns, output tokens, cache-read, average and peak resident context, compactions, the block-level tool mix, agent spawns by type, and the per-agent-type subagent rollup. It exists so a change to the pipeline is measured rather than argued about.
- `ac plan-stats [--dir]` reports the tier, complexity and codebase-state distributions across a corpus of plan files, which is how a change to the tier rules gets checked against what planners actually write.

- `/ac:install` Phase 4 gains Group D, an opt-in context trim covering unused built-ins, the scheduling stack, the task toolset, rarely-used bundled skills and the auto-mode classifier. Everything is unchecked by default and each option says which capability it removes, because `permissions.deny` strips a tool's schema rather than only blocking the call. No token figures are quoted: a tool that already defers costs its name rather than its schema, so the saving moves with the build and with whether tool search is on, and the section says how to measure it locally instead.

### Removed

- `ac:plan-reviewer-deep` and `ac:plan-code-deep-review` are merged into `ac:plan-reviewer` and `ac:plan-code-review`. The tier split was a fiction: across 139 review runs the standard variants ran twice and the deep ones ran 137 times, so every plan was already getting the deep body. `references/plan-review-core.md` and `references/code-review-core.md` are inlined into their single surviving consumer, since a shared core with one reader is indirection that costs a Read at every spawn.
- The plan's `Complexity` frontmatter field is gone, along with its classification rule. All three consumers went with the redesign: reviewer-tier routing, code-reviewer routing with the oracle default, and the wave-commit gate. Measured across 106 plans it had stopped classifying anything, with 84% landing on one value.
- The per-step `Verify` field is gone; its Nyquist requirement moved onto `Done when`, where at least one criterion must be provable by a single sub-60-second command that the wave barrier actually runs.
- The `review-counters` CLI subcommand is deleted. It had no callers once the review loops went, and its own defaults encoded what was removed: an `--iter-prefix` pointing at a heading nothing writes, and a cap and `MAX_ITER` gate for a loop that no longer exists.

### Fixed

- The three advisory agents, which are 62% of all subagent runs, carried three defects the pipeline redesign never touched. `ac:librarian` and `ac:oracle` still told themselves not to invoke `CallExternalAgent`, a tool removed from the CLI several releases ago. `omitClaudeMd: true` on `ac:explore` and `ac:librarian` did nothing: verified against the shipped 2.1.258 binary, the flag is only ever set on built-in agent definitions and the markdown frontmatter parser never reads it, so both agents were receiving the full CLAUDE.md hierarchy while their own frontmatter said otherwise. And the built-in-web-tools-first fallback rule, with its five failure conditions spelled out in full, appeared three times in one body and twice in another.
- `ac:librarian` and `ac:oracle` named three ac MCP tools in a form the server does not register (`ResolveLibrary` against `resolve-library`), while spelling two others out in full in the same sentences. There is no alias in either direction.
- `/ac:commit`, the most-invoked component on this machine at 822 runs, justified `--skip-preflight` in two places by pointing at a "Final Verification Wave (F1-F4)" in `/ac:execute`. No such phase exists, and none existed before the redesign either.
- The MCP server advertised version `0.9.1` to every client while both manifests read `0.11.0`. The number was typed into three places and bumped in none; it now reads `package.json`, with a test that walks the source for hardcoded version literals so the drift cannot recur.

- Group B in `/ac:install` presented seven options in a single flat `AskUserQuestion` call. The schema caps a question at four options and expects a `questions` array, so the prompt would have failed at the point where the operator opts into permission and telemetry keys. It now asks two questions, permissions and env keys, in one call.
- Group D set five bundled skills to `skillOverrides: "off"` under an option promising "Every one stays reachable by typing /name". Per the shipped 2.1.258 field documentation, `"off"` hides a skill from `/name` as well; only `"user-invocable-only"` keeps it. All seven entries now use `"user-invocable-only"`, and the section records what each of the four enum values hides so the next edit cannot repeat the swap.

Gives the plugin a memory of its own machine. `search-history` searches every Claude Code transcript this computer has ever written, across all projects, and `call-external-agent` leaves in the same release, so the local surface is now the two tools that read this machine's own state rather than one that drives other CLIs.

Most of what this entry records was found by using the tool rather than by testing it. The suites were green while an ordinary two-token query was an FTS5 syntax error, while a Turkish speaker typing ASCII was losing most of their own history, while the archive was quietly indexing its own searches, and while paging the project rollup announced a total that shrank as you read.

### Added

- `search-history`, an MCP tool that searches every Claude Code transcript on the machine, across all projects. One tool rather than a family: the mode, the project path, the date bounds, the role and kind filters, subagent inclusion and paging are all parameters inside it, and it borrows Grep's parameter vocabulary so there is no second vocabulary to learn. Backed by a permanent sqlite + FTS5 archive at `~/.claude/ac/history-index/`, built through Node's builtin `node:sqlite` behind a lazy import so the rest of the suite still runs under bun. Measured over the author's own 2,003 transcripts: 189,644 rows, 320 MB, a cold build of 25 to 50 s, and a warm no-change freshness pass of 0.45 s, which is what makes the per-call auto-sync affordable instead of needing a daemon. Five output modes: `content` for excerpts, `sessions` and `projects` for rollups (`projects` answers "which projects on this machine did I work on X in", which no other mode could without manual deduping), `count` for totals, and `read` to open one conversation. Secrets are redacted at ingest across 12 credential shapes, and `ac history forget` deletes by session, project or date. Turkish matching is diacritic-insensitive in both directions: `unicode61` folds every Turkish letter except `ı` (U+0131), which is a distinct letter rather than a diacritic-bearing `i`, so every query token is additionally expanded over the dotted/dotless axis. Before that expansion `calisiyor` found 138 of the 1,896 hits `çalışıyor` found; the two spellings now return an identical count. The archive also declines to index the search tool's own calls, so searching does not pollute the corpus being searched.
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

[0.24.0]: https://github.com/anilcancakir/claude-code/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/anilcancakir/claude-code/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/anilcancakir/claude-code/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/anilcancakir/claude-code/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/anilcancakir/claude-code/compare/v0.14.2...v0.20.0
[0.14.2]: https://github.com/anilcancakir/claude-code/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/anilcancakir/claude-code/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/anilcancakir/claude-code/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/anilcancakir/claude-code/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/anilcancakir/claude-code/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/anilcancakir/claude-code/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/anilcancakir/claude-code/compare/v0.10.1...v0.11.0
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
