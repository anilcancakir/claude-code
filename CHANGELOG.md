# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.3.0]: https://github.com/anilcancakir/claude-code/compare/v0.2.0...v0.3.0
