# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
