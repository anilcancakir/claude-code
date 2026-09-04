<div align=right>Table of Contents ↗</div>

# ac

Claude Code plans the work, routes each step to the cheapest model that can do it, and verifies four ways before calling it done.

[![License](https://img.shields.io/github/license/anilcancakir/claude-code)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/anilcancakir/claude-code/ci.yml?branch=main&label=CI)](https://github.com/anilcancakir/claude-code/actions/workflows/ci.yml)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-orange)](https://code.claude.com)

Ask a coding agent for a cross-file change and it starts editing. It has already decided the design, and you find out what it decided by reading the diff. The decisions that needed your judgment were made silently, the ones that did not took a turn each, and nothing checked the result beyond a green typecheck.

`ac` puts a file between the request and the first edit. You get interviewed for intent, the plan lands on disk as `.ac/plans/<slug>/plan.md`, an adversarial reviewer reads it before anything runs, and then it executes wave by wave with a commit per wave.

## Install

Inside Claude Code:

```
/plugin marketplace add anilcancakir/claude-code
/plugin install ac@ac
/ac:install
```

Then `/ac:plan <what you want>` for a new piece of work.

`/ac:install` is optional and interactive. It writes your global `CLAUDE.md`, generates two personal style skills from short interviews, and merges plugin parity into `settings.json`. Everything it writes is backed up first and gated behind a diff you approve.

## How it works

1. **Plan.** `/ac:plan` researches in parallel, interviews you for the decisions only you can make, audits for reuse, then writes a wave-and-step plan with a model tier on every step.
2. **Review.** `ac:plan-reviewer` reads the plan cold and reports what cannot work, before a single edit.
3. **Execute.** `/ac:execute` runs the plan wave by wave, spawning one worker per step at its declared tier.
4. **Verify.** Every wave passes four layers: automated checks, a hunk-by-hunk read of the wave diff, a hands-on QA scenario, and the plan's own checkboxes.
5. **Deliver.** One code-review pass over the whole change, then atomic commits split by concern.

## What makes it different

Plan-then-execute is a crowded category. Three things here are not common:

- **Tier routing.** Each step declares whether it needs haiku, sonnet or opus, and gets that model. Mechanical edits do not pay opus prices, and cross-layer work does not get attempted by haiku.
- **Four-layer verification per wave.** A passing typecheck is one layer of four. The wave diff is read hunk by hunk against what each worker claimed, and anything user-visible is exercised the way a person would use it.
- **Frozen completion criteria.** `/ac:auto` writes down what "done" means before work starts, hashes it, and hands the finished run to a read-only verifier that holds no `Edit`, `Write` or `Agent` tool, so it cannot change what it is judging.

## When not to use it

- A one-line fix or a single rename. The planning overhead is not worth it, and `/ac:plan` will tell you so.
- Exploration where you do not want a plan artifact on disk.
- A request whose definition of done cannot be written down before starting. `/ac:auto` refuses these at Phase 0 rather than guessing.

## What it installs

| | Count | |
|---|---:|---|
| Commands | 3 | `/ac:install`, `/ac:init-project`, `/ac:commit` |
| Skills | 9 | `ac:plan`, `ac:execute`, `ac:auto`, plus six authoring skills |
| Agents | 10 | three advisory, four tiered workers, two reviewers, one verifier |
| Hooks | 7 | three `PreToolUse`, two `Stop`, one `SessionStart` |
| Output styles | 1 | `ac:concise`, opt-in and never forced |
| MCP tools | 6 | docs lookup, code search, web fetch and search, local history search |

**On the hooks**, since they run code on your machine. Each one is gated and fails open, meaning any condition it cannot evaluate lets the action through unchanged. The three `PreToolUse` hooks fire only on plan-mode entry, only while an `/ac:execute` run is active in the current project, and only inside an `ac:explore` subagent. The two `Stop` hooks keep an in-flight run from ending its turn mid-plan. `SessionStart` reports whether a plan is still open. None of them makes a network call. Read them at [`plugins/ac/hooks/`](plugins/ac/hooks/).

**On the MCP server**, it runs locally as `node plugins/ac/cli/ac.js mcp`. `search-history` reads your own Claude Code transcripts from disk and never sends them anywhere.

## Reference

| Command | What it does |
|---------|--------------|
| `/ac:plan` | Parallel research, an intent interview, a reuse and efficiency audit, then a tier-assigned plan at `.ac/plans/<slug>/plan.md`. Skill. |
| `/ac:execute` | Runs an approved plan wave by wave with four-layer verification and a checkpoint commit per wave, closing with one code review. Skill. |
| `/ac:auto` | Freezes completion criteria under a hash, chains plan into execute, then gates the result with a read-only verifier. Never pushes. Skill. |
| `/ac:install` | Writes your global `CLAUDE.md`, generates the `my-coding` and `my-language` skills, merges `settings.json` parity, and offers the opt-in `ac:concise` output style. |
| `/ac:init-project` | Investigates a project with four parallel agents, then writes its `CLAUDE.md`, `CLAUDE.local.md` and path-scoped `.claude/rules/*.md`, plus a linter hook and a language server each proved to work. |
| `/ac:commit` | Atomic commits with style detected from recent history, multi-file splitting and test pairing. |

| Agent | Model | Role |
|-------|-------|------|
| `ac:explore` | haiku | Codebase research with `file:line` citations, at a `quick`, `medium` or `thorough` depth. |
| `ac:librarian` | sonnet | External docs and OSS research with URL and permalink citations. |
| `ac:oracle` | opus | Verifying advisor. Tests the premises a brief rests on before answering it. Advises, never edits. |
| `ac:plan-worker-quick` | haiku | Mechanical single-file steps: config edits, renames, scaffolds. |
| `ac:plan-worker-junior` | sonnet | Standard steps: one to three files, business logic, framework idiom. |
| `ac:plan-worker-junior-high` | sonnet | Junior's model at high effort, for borderline coupling or context depth. |
| `ac:plan-worker-senior` | opus | Cross-layer changes, migrations and complex edges with caller-impact checks. |
| `ac:plan-reviewer` | opus | Advisory pass over the written plan. Reports findings, gives no verdict. |
| `ac:plan-code-review` | opus | Post-implementation pass over the diff. Reports findings, gives no verdict. |
| `ac:auto-verifier` | opus | Read-only completion gate for `/ac:auto`. Holds no `Edit`, `Write` or `Agent`. |

The six authoring skills (`ac:skill-creator`, `ac:command-creator`, `ac:agent-creator`, `ac:claude-md-rules-creator`, `ac:prompt-writer`, `ac:git-master`) are what the plan chain calls when the work is itself a skill, command, agent or `CLAUDE.md` file.

## Repository layout

```
plugins/ac/          The plugin: commands, skills, agents, hooks, output styles, references.
plugins/ac/cli/      Bundled MCP runtime (ac.js), built from cli/ac/.
cli/ac/              CLI source, TypeScript on Bun.
.claude-plugin/      Marketplace manifest.
```

The CLI source at `cli/ac/` builds to `plugins/ac/cli/ac.js` as Node-targeted ESM, which Claude Code loads through `plugins/ac/.mcp.json`. Never hand-edit the bundle; `cd cli/ac && bun run build` regenerates it.

## Requirements

- Claude Code with plugin and marketplace support.
- Node.js >= 22.13.0 for the bundled MCP runtime. The floor is 22.13.0 rather than 20 because the history archive uses the `node:sqlite` builtin, which is unflagged only from that version. The import is lazy, so an older Node loses `search-history` rather than the whole server.
- [Bun](https://bun.sh) >= 1.1.0, for CLI development and builds only. Not needed to use the plugin.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the build, typecheck and test pipeline, and the PR checklist.

## License

MIT. See [LICENSE](LICENSE).
