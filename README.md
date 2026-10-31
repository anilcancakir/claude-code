<div align=right>Table of Contents ↗</div>

# ac

Claude Code plans the work, routes each step to the cheapest model that can do it, and verifies four ways before calling it done.

[![License](https://img.shields.io/github/license/anilcancakir/claude-code)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/anilcancakir/claude-code/ci.yml?branch=main&label=CI)](https://github.com/anilcancakir/claude-code/actions/workflows/ci.yml)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-orange)](https://code.claude.com)

Ask a coding agent for a cross-file change and it starts editing. It has already decided the design, and you find out what it decided by reading the diff. The decisions that needed your judgment were made silently, the ones that did not took a turn each, and nothing checked the result beyond a green typecheck.

`ac` puts a file between the request and the first edit. You get interviewed for intent, the plan lands on disk as `.ac/plans/<slug>/plan.md`, an adversarial reviewer reads it before anything runs, and then it executes wave by wave with a commit per wave.

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

Then `/ac:plan <what you want>` for a new piece of work.

`/ac:install` is optional and interactive. It writes your global `CLAUDE.md`, generates two personal style skills from short interviews, and merges plugin parity into `settings.json`. Everything it writes is backed up first and gated behind a diff you approve. After a plugin update, `/ac:install --upgrade` brings that setup up to the new version and asks only about options added since the last run.

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

## While you are away

- **Hand off mid-session.** Say you are leaving and run `/ac:auto`: it carries the work already under way (a `/ac:coordinate` run, a plan interview or review, a running execute, a written plan, or an ad-hoc task) to its end instead of starting over or declining, asks you nothing while you are gone, logs every choice it made for you in `.ac/away/<slug>/decisions.md`, and ends on a verdict from the read-only verifier. It pushes, merges, opens a PR, releases or deploys only when your words named that action.
- **Questions that time out.** The opt-in AFK timer (`/ac:install`, W.afk) lets an unanswered question time out after three minutes. The plugin answers it with a wait by default; inside an `/ac:auto` or `/ac:coordinate` run a question that is not a blocker continues on its Recommended option, recorded as not user-approved. Blockers wait for you. Under `/ac:auto` no question is asked in the first place.
- **Session titles that follow the work.** Claude Code titles a session once, from its first prompt. The opt-in title hook (`AC_SESSION_TITLE=1`) renames it from its recent context on the first prompt and every tenth after it, with your own naming prompt or a format such as tracker keys, and never over a title you set with `/rename`.

## When not to use it

- A one-line fix or a single rename. The planning overhead is not worth it, and `/ac:plan` will tell you so.
- Exploration where you do not want a plan artifact on disk.
- A request whose definition of done cannot be written down before starting. `/ac:auto` refuses these at Phase 0 rather than guessing.

## What it installs

| | Count | |
|---|---:|---|
| Commands | 3 | `/ac:install`, `/ac:init-project`, `/ac:commit` |
| Skills | 11 | `ac:plan`, `ac:execute`, `ac:auto`, `ac:coordinate`, `ac:qa`, plus six authoring skills |
| Agents | 12 | three advisory, four tiered workers, two reviewers, one verifier, one QA tester, one coordinator lane |
| Hooks | 17 | five `PreToolUse`, two `PostToolUse`, four `Stop`, one `SubagentStop`, three `SessionStart`, one `SessionEnd`, one `UserPromptSubmit` |
| Output styles | 1 | `ac:concise`, opt-in and never forced |
| MCP tools | 6 | docs lookup, code search, web fetch and search, local history search |

**On the hooks**, since they run code on your machine. Each one is gated and fails open, meaning any condition it cannot evaluate lets the action through unchanged. Four of the five `PreToolUse` hooks fire only on plan-mode entry, only while an `/ac:execute` run is active in the current project, only during an `/ac:auto` run, and only inside an `ac:explore` subagent, where it caps the call count and blocks secret-file reads and the common write forms (a formatter in write mode, installs, file and git changes). Three `Stop` hooks keep an in-flight `/ac:execute`, `/ac:auto` or `/ac:coordinate` run from ending its turn mid-plan; all four `Stop` hooks let the turn end while a background worker or a finite background command is still running, because its notification starts the next turn. A recognised dev server does not count, and the three run guards count a background command only when it is a recognised finite job such as a test or a build, since anything else can run forever. The announce guard runs in every interactive main-thread session, in any project: it reads only the last paragraph of the reply, and when that paragraph looks like an announced next step, an offer to continue, or a question asked in prose, it asks a second model before continuing the turn. That judge is a `claude -p` call on Sonnet with no user settings, installed plugins, MCP servers, tools or saved session, sent the reply and your last request, bounded at 20 seconds, and the turn ends normally on any timeout or error, or when the session points at another endpoint through `ANTHROPIC_BASE_URL`. It continues a turn at most once per stall and 3 times per prompt, skips `claude -p` sessions, and `AC_ANNOUNCE_GUARD_MAX_BLOCKS=0` turns it off. One `SessionStart` hook reports whether a plan or a coordinator run is still open; another adds the ac working rules to the main thread when the launch did not already pass them through the shell wrapper. The fifth `PreToolUse` hook fires only inside an `ac:*` subagent and denies a Bash `find`, recursive `grep`, `rg` or `fd` rooted at `/` or your home directory, a search over `~/.claude/projects`, and `strings` or `grep -a` on a file over 100 MiB, with a bounded recipe in each denial. The `SubagentStop` hook blocks an `ac:*` subagent once, at its final report, while a background task it started is still running, and asks it to stop each one. The `SessionEnd` hook and the third `SessionStart` hook (on `startup` only) run `ac lease sweep` in a detached process, which stops a pid, an Android emulator, an iOS simulator or a Playwright session that a session recorded with `ac lease add`, and the leftovers of sessions whose process is gone; it never runs a `close-all` or `kill-all`. One `PostToolUse` hook answers an `AskUserQuestion` that timed out while you were away, with a wait by default (`AC_QUESTION_TIMEOUT=0` turns it off). The other reads only the auto-memory index, `projects/<project>/memory/MEMORY.md` under your Claude config directory, right after Claude writes it: Claude Code loads the first 200 lines or 25KB of it into every session of that project, so past 80 lines, 10KB or a 150-byte line it tells Claude to consolidate the index into shorter pointers and themed sub-indexes. An index moved by `autoMemoryDirectory` is not covered. It never edits the file, and `AC_MEMORY_INDEX_MAX_LINES`, `AC_MEMORY_INDEX_MAX_BYTES` and `AC_MEMORY_INDEX_MAX_LINE_BYTES` move each limit (0 turns one off). The `UserPromptSubmit` hook is off unless you set `AC_SESSION_TITLE=1`; then, on the first prompt and every tenth after it, it names the session from its recent context with a detached `claude -p` on Haiku, and it never overwrites a title you set with `/rename`. The judge and that title hook are the only hooks that make a network call, both through your own Claude Code login. Read them at [`plugins/ac/hooks/`](plugins/ac/hooks/).

**On the MCP server**, it runs locally as `node plugins/ac/cli/ac.js mcp`. `search-history` reads your own Claude Code transcripts from disk and never sends them anywhere.

## Reference

| Command | What it does |
|---------|--------------|
| `/ac:plan` | Parallel research, an intent interview, a reuse and efficiency audit, then a tier-assigned plan at `.ac/plans/<slug>/plan.md`. Skill. |
| `/ac:execute` | Runs an approved plan wave by wave with four-layer verification and a checkpoint commit per wave, closing with one code review and, when the plan asks for one, a QA pass after it. Skill. |
| `/ac:auto` | Away mode: carries the run already going (a coordinate run, a plan, an execute run, ad-hoc work) to its end without asking you anything, or starts a new one from the request, against completion criteria frozen under a hash, then gates the result with a read-only verifier. Pushes, merges or deploys only what you named. Skill. |
| `/ac:product` | Product-manager pass for one idea: feasibility research with agents, a full interview, then `docs/prd/<slug>.md`, `docs/ROADMAP.md` and one `.ac/tasks/` file per bundle for `/ac:plan` and `/ac:coordinate`. Writes documents only; you start it and you pick what runs next. Skill. |
| `/ac:coordinate` | Coordinator for a request too large for one plan: researches it, settles a roadmap with you, has `ac:oracle` review it, then runs each bundle through an `ac:lane` subagent in its own git worktree into a local `coord/<slug>` branch. Ends with an `ac:auto-verifier` verdict and one push you approve. Skill. |
| `/ac:qa` | QA-engineer pass over a session's or a plan's work with the project's own test tool (playwright-cli as the fallback): functional, responsive, design and security checks, critical and high findings fixed with one bounded retest, learnings kept in `.ac/qa/learnings.md`. Skill. |
| `/ac:install` | Writes your global `CLAUDE.md`, generates the `my-coding` and `my-language` skills, merges `settings.json` parity, and offers the opt-in `ac:concise` output style. `--upgrade` re-applies it after a plugin update and asks only what is new. |
| `/ac:init-project` | Investigates a project with four parallel agents, shows one proposal, and on approval writes its `CLAUDE.md` (importing an `AGENTS.md`), `CLAUDE.local.md`, path-scoped `.claude/rules/*.md`, secret-file deny and routine-command allow rules, and a lint or format hook and a language server, each verified, after one `ac:oracle` review of the drafts. |
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

Two skills carry the default flow. `ac:flow` runs a medium or large request on the main thread: parallel research, an interview for open decisions, building in slices through the plan-worker tiers, and an oracle review, without writing a plan. `ac:frontend-design` builds web, iOS-feel, Material-feel and Flutter UI from a committed direction and a token plan, with `ac:design-director` deciding the look, an optional Google Stitch branch, and a `DESIGN.md` contract.

The seven authoring skills (`ac:skill-creator`, `ac:agent-creator`, `ac:claude-md-rules-creator`, `ac:project-md-writer`, `ac:design-md-writer`, `ac:prompt-writer`, `ac:git-master`) are what the plan chain calls when the work is itself a skill, agent, `CLAUDE.md` file, or a PROJECT.md or DESIGN.md.

## Also in this marketplace

`ac-lsp` runs Dart and Intelephense through a small proxy that keeps each server in step with the disk. Claude Code tells a language server only about its own Edit and Write changes, so without it an edit from Bash, git, a formatter or another session leaves the server analysing old content. Intelephense also skips `build/` and `.claude/worktrees/`, so indexing finishes in Flutter monorepos. Disable the stock `php-lsp` and `dart` plugins first, then `/plugin install ac-lsp@ac`; [`plugins/ac-lsp/README.md`](plugins/ac-lsp/README.md) has the details and the per-project override.

## Repository layout

```
plugins/ac/          The plugin: skills, agents, hooks, output styles, references.
plugins/ac/docs/     Human-facing guides, such as the iTerm2 terminal setup.
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
