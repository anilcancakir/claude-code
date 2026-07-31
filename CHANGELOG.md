# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.4.2]: https://github.com/anilcancakir/claude-code/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/anilcancakir/claude-code/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/anilcancakir/claude-code/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anilcancakir/claude-code/compare/v0.2.0...v0.3.0
