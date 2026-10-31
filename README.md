<div align=right>Table of Contents ↗</div>

# ac

Describe the change. `ac` researches it, builds it in slices on the cheapest model that can do each, checks the result with tests and an independent review, and keeps going while you are away.

[![Release](https://img.shields.io/github/v/release/anilcancakir/claude-code)](https://github.com/anilcancakir/claude-code/releases)
[![License](https://img.shields.io/github/license/anilcancakir/claude-code)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/anilcancakir/claude-code/ci.yml?branch=main&label=CI)](https://github.com/anilcancakir/claude-code/actions/workflows/ci.yml)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-orange)](https://code.claude.com)

Ask a coding agent for a cross-file change and it starts editing. It has already decided the design, and you find out what it decided by reading the diff. The decisions that needed your judgment were made silently, the ones that did not took a turn each, and nothing checked the result beyond a green typecheck.

`ac` is a Claude Code plugin that fixes the order of operations. The research happens first and on cheap models. You are asked only what the code and the docs could not settle. The work is built in slices, each on the model it needs. Something other than the builder reads the result before it is reported.

## Install

Inside Claude Code, in one step:

```
/plugin install ac --marketplace anilcancakir/claude-code
```

Or add the marketplace and install in two steps:

```
/plugin marketplace add anilcancakir/claude-code
/plugin install ac@ac
/ac:install
```

Then describe what you want. `/ac:install` is optional and interactive: it writes your global `CLAUDE.md`, generates two personal style skills from short interviews, and merges plugin parity into `settings.json`. Everything it writes is backed up first and gated behind a diff you approve. After a plugin update, `/ac:install --upgrade` asks only about options added since the last run.

## What a run looks like

```
> add a rate limit to the public API, with a Retry-After header and tests
```

1. The working rules size the request. A one-file fix is done directly; this one crosses several files, so it runs `ac:flow`.
2. `ac:explore` (Haiku) maps your code and `ac:librarian` (Sonnet) reads the framework docs, in parallel.
3. You answer the one thing they could not settle, such as which limiter store to use. Nothing else.
4. The change is built in slices. Mechanical edits go to Haiku workers, standard work to Sonnet, cross-layer work to Opus. Each worker checks its own files, and the orchestrator checks the wave.
5. The full test suite and lint run in the background while `ac:oracle` reads the diff against what you asked for.
6. You get the result, what the review found, and what stayed unverified.

## What you get

- **A default flow that asks little.** `ac:flow` runs any medium or large request on the main thread: parallel research, an interview scaled to the size, slices on tiered workers, one review. It writes no plan file.
- **A plan on disk when you want a document.** `/ac:plan` researches, interviews you for the decisions only you can make, has an adversarial reviewer read the plan cold, and writes a wave-and-step plan with a model tier on every step. `/ac:execute` runs it wave by wave with a commit per wave.
- **Work that finishes while you are away.** `/ac:auto` carries the run already under way to its end, logs every choice it made for you, and stops at a read-only verifier.
- **Requests too big for one plan.** `/ac:coordinate` splits a request into bundles and runs each in its own git worktree.
- **A QA pass.** `/ac:qa` derives cases from the requirement and the diff, runs them against the live app, and fixes critical and high findings once.
- **Idea to roadmap.** `/ac:product` runs a feasibility pass and an interview, then writes a PRD, a roadmap and one task file per bundle.
- **UI with a direction instead of defaults.** `ac:frontend-design` has a read-only design director commit a look and a token plan before any component is written.
- **Instruction files that stay small.** `/ac:init-project` audits `CLAUDE.md`, rules and auto-memory line by line; hooks hold each memory file to a size budget.

## What makes it different

Plan-then-execute is a crowded category. Three things here are not common:

- **Tier routing.** Each step declares whether it needs Haiku, Sonnet or Opus, and gets that model. Mechanical edits do not pay Opus prices, and cross-layer work does not get attempted by Haiku.
- **Layered verification.** Workers check their own files. The wave diff is read hunk by hunk against what each worker claimed. The full suite runs once, in the background, beside the reviewer. Anything user-visible is exercised the way a person would use it.
- **Frozen completion criteria.** `/ac:auto` writes down what "done" means before work starts, hashes it, and hands the finished run to a verifier that holds no `Edit`, `Write` or `Agent` tool and judges against criteria that are hashed, so a change to them shows.

## While you are away

- **Hand off mid-session.** Say you are leaving and run `/ac:auto`: it carries the work already under way (a `/ac:coordinate` run, a plan interview or review, a running execute, a written plan, or an ad-hoc task) to its end instead of starting over, asks you nothing while you are gone, logs every choice in `.ac/away/<slug>/decisions.md`, and ends on a verdict from the read-only verifier. It pushes, merges, opens a PR, releases or deploys only when your words named that action.
- **Questions that time out.** The opt-in AFK timer (`/ac:install`, W.afk) lets an unanswered question time out after three minutes. The plugin answers it with a wait by default; inside an `/ac:auto` or `/ac:coordinate` run a question that is not a blocker continues on its Recommended option, recorded as not user-approved. Blockers wait for you.
- **Session titles that follow the work.** The opt-in title hook (`AC_SESSION_TITLE=1`) renames a session from its recent context on the first prompt and every tenth after it, and never over a title you set with `/rename`.

## When not to use it

- A one-line fix or a single rename. The working rules do those directly, because the planning overhead is not worth it.
- Exploration where you do not want a plan artifact on disk.
- A request whose definition of done cannot be written down before starting. `/ac:auto` declines to start a new run on these rather than guessing.

## What it installs

| | Count | |
|---|---:|---|
| Skills | 19 | `ac:flow`, `ac:plan`, `ac:execute`, `ac:auto`, `ac:coordinate`, `ac:qa`, `ac:product`, `ac:frontend-design`, `ac:commit`, `ac:install`, `ac:init-project`, plus eight authoring and reference skills |
| Agents | 13 | four advisory, four tiered workers, two reviewers, one verifier, one QA tester, one coordinator lane |
| Hooks | 21 | seven `PreToolUse`, four `PostToolUse`, four `Stop`, three `SessionStart`, one each of `SubagentStop`, `SessionEnd` and `UserPromptSubmit` |
| Output styles | 1 | `ac:concise`, opt-in and never forced |
| MCP tools | 6 | docs lookup, code search, web fetch and search (five, through the kodizm service) and a local history search |

**On the hooks**, since they run code on your machine. Each one fails open: any condition it cannot evaluate lets the action through unchanged. Eight are gated to a run you started or to an `ac` subagent. The other thirteen are registered for every session: they steer native plan mode toward the working rules, deny writes to `CLAUDE.md`, rules, `PROJECT.md` and `DESIGN.md` until the matching writer skill is loaded, hold those files to a size budget, confirm a Dart or PHP diagnostic against the command-line analyzer, deliver the working rules, and, when a reply ends on an announced next step, ask a second model through your own Claude login whether to continue the turn. `plugins/ac/docs/hooks.md` lists every hook with when it fires and how to switch it off, and the scripts are in [`plugins/ac/hooks/`](plugins/ac/hooks/).

**On the MCP server**, it runs locally as `node plugins/ac/cli/ac.js mcp`. `search-history` reads your own Claude Code transcripts from disk and never sends them anywhere. The other five tools (docs lookup, code search, web search and fetch) proxy to the kodizm service at `mcp.kodizm.com` and need a `KODIZM_MCP_TOKEN`; without one the server offers only a local `web-fetch` and `search-history`.

## Also on opencode

The same workflow runs on [opencode](https://opencode.ai): eight commands, thirteen agents and thirteen skills, a diagnostics block after every edit, model chains that move a failed child down a list of fallbacks, and the same away-run guards. It is a hand-kept port, each file stamped with a hash of its Claude Code source so a change on one side cannot pass CI without the other. Install and presets are in [`opencode/ac/README.md`](opencode/ac/README.md).

## Reference

| Skill | What it does |
|-------|--------------|
| `/ac:flow` | The default build flow for a medium or large request: parallel research on cheap agents, an interview for what blocks, slices built on the worker tiers, one `ac:oracle` review. Writes no plan file. The working rules start it; you can also type it. |
| `/ac:plan` | Parallel research, an intent interview, a reuse and efficiency audit, then a tier-assigned plan at `.ac/plans/<slug>/plan.md`. Starts only when you ask for a written plan. |
| `/ac:execute` | Runs an approved plan wave by wave with layered verification and a checkpoint commit per wave, closing with one code review and, when the plan asks for one, a QA pass. |
| `/ac:auto` | Away mode: carries the run already going (a coordinate run, a plan, an execute run, ad-hoc work) to its end without asking you anything, or starts a new one from the request, against completion criteria frozen under a hash, then gates the result with a read-only verifier. Pushes, merges or deploys only what you named. |
| `/ac:coordinate` | Coordinator for a request too large for one plan: researches it, settles a roadmap with you, has `ac:oracle` review it, then runs each bundle through an `ac:lane` subagent in its own git worktree into a local `coord/<slug>` branch. Ends with an `ac:auto-verifier` verdict and one push you approve. |
| `/ac:qa` | QA-engineer pass over a session's or a plan's work with the project's own test tool (playwright-cli as the fallback): functional, responsive, design and security checks, critical and high findings fixed with one bounded retest, learnings kept in `.ac/qa/learnings.md`. |
| `/ac:product` | Product-manager pass for one idea: feasibility research with agents, a full interview, then `docs/prd/<slug>.md`, `docs/ROADMAP.md` and one `.ac/tasks/` file per bundle for `/ac:plan` and `/ac:coordinate`. Writes documents only; you start it and you pick what runs next. |
| `ac:frontend-design` | Builds web, iOS-feel, Material-feel and Flutter UI from a committed direction and a token plan, with `ac:design-director` deciding the look, an optional Google Stitch branch, and a `DESIGN.md` contract. |
| `/ac:install` | Writes your global `CLAUDE.md`, generates the `my-coding` and `my-language` skills, merges `settings.json` parity, and offers the opt-in `ac:concise` output style. `--upgrade` re-applies it after a plugin update and asks only what is new. |
| `/ac:init-project` | Investigates a project with parallel agents, or audits an existing setup (every `CLAUDE.md`, rule and the auto-memory, line by line), shows one proposal, and on approval writes `CLAUDE.md` (importing an `AGENTS.md`), `CLAUDE.local.md`, path-scoped `.claude/rules/*.md`, secret-file deny and routine-command allow rules, and a lint or format hook and a language server, after one `ac:oracle` review of the drafts. `--propose-only` writes everything under `.ac/init/proposed/` and changes nothing else. |
| `/ac:commit` | Atomic commits with style detected from recent history, multi-file splitting and test pairing. |

| Agent | Model | Role |
|-------|-------|------|
| `ac:explore` | haiku | Codebase research with `file:line` citations, at a `quick`, `medium` or `thorough` depth. |
| `ac:librarian` | sonnet | External docs and OSS research with URL and permalink citations. |
| `ac:oracle` | opus | Read-only reviewer: checks a plan, diff, report or config change against its sources, with a short advice mode. Never edits. |
| `ac:design-director` | opus | Read-only design director: three visual directions, a committed token plan, or a screenshot critique. Returns decisions, never code. Called by `ac:frontend-design`. |
| `ac:plan-worker-quick` | haiku | Mechanical single-file steps: config edits, renames, scaffolds. |
| `ac:plan-worker-junior` | sonnet | Standard steps: one to three files, business logic, framework idiom. |
| `ac:plan-worker-junior-high` | sonnet | Junior's model and effort, for steps the planner marks borderline on coupling or context depth. |
| `ac:plan-worker-senior` | opus | Cross-layer changes, migrations and complex edges with caller-impact checks. |
| `ac:plan-reviewer` | sonnet | Advisory pass over the written plan at effort `xhigh`. Reports findings, gives no verdict. |
| `ac:plan-code-review` | opus | Post-implementation pass over the diff. Reports findings, gives no verdict. |
| `ac:auto-verifier` | opus | Read-only completion gate for `/ac:auto` and `/ac:coordinate`. Holds no `Edit`, `Write` or `Agent`. |
| `ac:qa-tester` | sonnet | Runs the QA cases from a brief and writes a report with evidence. Never edits application code; writes only inside its run directory. |
| `ac:lane` | sonnet | One roadmap bundle of a `/ac:coordinate` run, in its own git worktree: plans it with `ac:plan --lane`, executes it with `ac:execute --lane`, reports to the coordinator. Spawned only by `/ac:coordinate`. |

Eight further skills write and audit the files Claude reads: `ac:skill-creator`, `ac:agent-creator`, `ac:claude-md-rules-creator`, `ac:project-md-writer`, `ac:design-md-writer`, `ac:prompt-writer`, plus `ac:git-master` for history work and `ac:github-cli`, which the librarian loads for GitHub research. The plan chain calls them when the work is itself a skill, an agent, a `CLAUDE.md` file, or a PROJECT.md or DESIGN.md.

## Also in this marketplace

`ac-lsp` runs Dart and Intelephense through a small proxy that keeps each server in step with the disk. Claude Code tells a language server only about its own Edit and Write changes, so without it an edit from Bash, git, a formatter or another session leaves the server analysing old content. Intelephense also skips `build/` and `.claude/worktrees/`, so indexing finishes in Flutter monorepos. Disable the stock `php-lsp` and `dart` plugins first, then `/plugin install ac-lsp@ac`; [`plugins/ac-lsp/README.md`](plugins/ac-lsp/README.md) has the details and the per-project override.

## Repository layout

```
plugins/ac/          The plugin: skills, agents, hooks, output styles, references.
plugins/ac/docs/     Human-facing guides, such as the hook list and the iTerm2 terminal setup.
plugins/ac/cli/      Bundled MCP runtime (ac.js), built from cli/ac/.
plugins/ac-lsp/      Dart and Intelephense behind a disk-sync proxy (bin/ built from cli/ac/).
cli/ac/              CLI source, TypeScript on Bun.
.claude-plugin/      Marketplace manifest.
```

The CLI source at `cli/ac/` builds to `plugins/ac/cli/ac.js` as Node-targeted ESM, which Claude Code loads through `plugins/ac/.mcp.json`. Never hand-edit the bundle; `cd cli/ac && bun run build` regenerates it.

## Requirements

- Claude Code with plugin and marketplace support.
- Node.js >= 22.13.0 for the bundled MCP runtime. The floor is 22.13.0 rather than 20 because the history archive uses the `node:sqlite` builtin, which is unflagged only from that version. The import is lazy, so an older Node loses `search-history` rather than the whole server.
- On Windows, Git for Windows (Git Bash). The plugin's hooks are `sh` scripts; without Git Bash Claude Code runs them in PowerShell, where a guard that fails blocks the call.
- [Bun](https://bun.sh) >= 1.1.0, for CLI development and builds only. Not needed to use the plugin.

For iTerm2 with one session per tab (fullscreen renderer, clean copying, no left arrow agent view, swipe between tabs), see [`plugins/ac/docs/terminal-setup.md`](plugins/ac/docs/terminal-setup.md). It is machine setup, independent of the plugin.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the build, typecheck and test pipeline, and the PR checklist.

## License

MIT. See [LICENSE](LICENSE).
