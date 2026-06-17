# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
