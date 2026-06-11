# ac

Plan-first development partner for Claude Code: interview-driven plans, tier-routed agents (haiku/sonnet/opus), and an adversarial review chain that verifies through real usage, not a green typecheck.

[![License](https://img.shields.io/github/license/anilcancakir/claude-code)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/anilcancakir/claude-code/ci.yml?branch=main&label=CI)](https://github.com/anilcancakir/claude-code/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.3.0-blue)](CHANGELOG.md)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-orange)](https://code.claude.com)

## Overview

`ac` is a Claude Code plugin marketplace whose headline plugin turns a feature request into a reviewed, tier-routed execution plan. It interviews you for intent, drafts a wave-and-step plan, and routes each step to the cheapest model that can do it well: haiku for mechanical edits, sonnet for pattern work, opus for cross-layer changes. Every plan passes an adversarial reviewer before execution, and every step is verified four ways, including hands-on runtime QA rather than a passing typecheck alone.

## Why / Why not

**Use it for:**

- Cross-file features where the change in one shape propagates to distant callers.
- Refactors and migrations that need a plan and a caller-impact check before the first edit.
- Bug investigations that need discipline: a reproducer first, then a verified fix.

**Skip it for:**

- Trivial one-line edits or a single rename. The planning overhead is not worth it.
- Throwaway exploration where you do not want a plan artifact on disk.

## Quickstart

Run these as slash commands inside Claude Code:

```
/plugin marketplace add anilcancakir/claude-code
/plugin install ac@ac
/ac:install
```

`/ac:install` runs an interactive post-install setup: it creates the `my-coding` and `my-language` user skills from short style interviews, merges a portable delegation section into your global `CLAUDE.md`, and idempotently merges plugin parity into `settings.json`. After install, start with `/ac:plan` for a new piece of work.

## Commands

| Command | What it does |
|---------|--------------|
| `/ac:plan` | Interactive planner: parallel research, an intent interview, a reuse/quality/efficiency audit, then a tier-assigned wave-and-step plan written to `.ac/plans/<slug>/plan.md`. (Skill.) |
| `/ac:execute` | Runs an approved plan wave by wave on the main thread, spawning tier-routed workers, with per-step 4-layer verification and a final code review. (Skill.) |
| `/ac:install` | Interactive post-install setup: `my-coding` / `my-language` skills, global `CLAUDE.md` delegation, and `settings.json` parity. |
| `/ac:init-project` | Deep project initialization: parallel `ac:explore` agents, a scored subdirectory-rule matrix, and drafted `CLAUDE.md` / `CLAUDE.local.md` / `.claude/rules/*.md`. |
| `/ac:commit` | Atomic commits with style detection from recent history, multi-file splitting, test pairing, optional preflight, and push when an upstream exists. |

## Skills

Two skills are user-invocable and back the planning workflow:

- **`ac:plan`**: the planner behind `/ac:plan`.
- **`ac:execute`**: the executor behind `/ac:execute`.

Six further skills are internal authoring tools the plan chain calls on its own: `ac:skill-creator`, `ac:command-creator`, `ac:agent-creator`, `ac:claude-md-rules-creator`, `ac:prompt-writer`, and `ac:git-master`.

## Agents

Ten subagents back the workflow. Advisory agents answer questions; plan-chain workers execute steps; reviewers gate the plan and the implementation.

| Agent | Model | Role |
|-------|-------|------|
| `ac:explore` | haiku | Deep, parallel-friendly codebase research; returns `file:line` citations with LSP/AST-grep precision. |
| `ac:librarian` | sonnet | External documentation and OSS research; returns URL/permalink citations with code-snippet evidence. |
| `ac:oracle` | opus | Strategic advisor for architecture, debugging stalls, and reuse-vs-build trade-offs; advises, never executes. |
| `ac:plan-worker-quick` | haiku | Mechanical single-file step executor: config edits, renames, scaffolds, doc-block additions. |
| `ac:plan-worker-junior` | sonnet | Standard step executor: 1-3 file changes, business logic, pattern and framework-idiom application. |
| `ac:plan-worker-senior` | opus | Senior step executor: cross-layer changes, migrations, and complex edges with caller-impact checks. |
| `ac:plan-reviewer` | sonnet | Independent second-eye reviewer for `standard` plans; returns OKAY or REJECT with up to 3 blockers. |
| `ac:plan-reviewer-deep` | opus | Adversarial two-pass reviewer for `complex` plans; stress-tests across seven dimensions. |
| `ac:plan-code-review` | sonnet | 4-stage post-implementation reviewer for `standard` plans; returns APPROVED or BLOCKED. |
| `ac:plan-code-deep-review` | opus | 6-stage post-implementation reviewer for `complex` plans, including cross-layer integration and Reuse Map enforcement. |

## Plugin structure

```
plugins/ac/
  .claude-plugin/
    plugin.json          Plugin manifest.
  .mcp.json              MCP entrypoint (node cli/ac.js mcp).
  agents/                10 subagents (advisory, workers, reviewers).
  commands/              /ac:install, /ac:init-project, /ac:commit.
  skills/                8 skills (ac:plan, ac:execute + 6 creators).
  cli/                   Bundled MCP runtime (ac.js, built from cli/ac/).
  bin/                   CLI launcher.
  references/            Bundled style/CLAUDE.md templates for /ac:install.
  README.md
```

| Component | Lives in | Loaded as |
|-----------|----------|-----------|
| Commands | `plugins/ac/commands/` | `/ac:<name>` |
| Skills | `plugins/ac/skills/<name>/SKILL.md` | `ac:<name>` |
| Agents | `plugins/ac/agents/<name>.md` | `ac:<name>` (subagents) |
| CLI / MCP | `plugins/ac/cli/ac.js` | MCP server via `.mcp.json` |

The CLI source lives at `cli/ac/` (TypeScript on Bun) and builds to `plugins/ac/cli/ac.js` (Node-targeted ESM) that Claude Code loads through `plugins/ac/.mcp.json`.

## Requirements

- A recent version of [Claude Code](https://code.claude.com) with plugin and marketplace support.
- Node.js >= 20 for the bundled MCP runtime that Claude Code loads at `plugins/ac/cli/ac.js`.
- [Bun](https://bun.sh) for CLI development and builds (`cd cli/ac && bun run build`).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the build/typecheck/test pipeline, and the PR checklist.

## License

MIT. See [LICENSE](LICENSE).
