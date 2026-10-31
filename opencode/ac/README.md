# ac for opencode

The `ac` workflow on [opencode](https://opencode.ai): describe a change, and it researches it, builds it in slices on the cheapest model that can do each, checks the result with tests and an independent review, and keeps going while you are away. It is a port of the [Claude Code plugin](../../plugins/ac/README.md), kept in step with it file by file.

## What you get

- **Eight commands.** `/ac/plan`, `/ac/execute`, `/ac/coordinate`, `/ac/commit`, `/ac/qa`, `/ac/flow`, `/ac/auto` and `/ac/product`. A request sized medium or large runs through `flow` on its own; the others start when you type them.
- **Thirteen agents.** Read-only researchers and reviewers (`ac/explore`, `ac/librarian`, `ac/oracle`, `ac/plan-reviewer`, `ac/plan-code-review`, `ac/design-director`, `ac/auto-verifier`), four cost-tiered workers (`ac/plan-worker-quick`, `-junior`, `-junior-high`, `-senior`), `ac/lane` for parallel worktrees and `ac/qa-tester`.
- **Thirteen skills.** The workflows above plus `git-master`, `github-cli`, `frontend-design`, `design-md-writer` and `project-md-writer`.
- **Guards that act on the run.** A worker edits only the files of its wave; a turn that ends while an execute or away run is unfinished is nudged on; read-only agents cannot write through the shell; an `/ac/auto` run pushes, merges or releases only what you named, and irreversible git verbs stay denied while it lives.
- **Model chains.** Each agent has an ordered list of models. A provider failure moves the same child down the list, and a rate limit waits and retries instead of burning the chain.
- **Diagnostics after an edit.** Edit and write results carry a `<diagnostics>` block from `php -l`, PHPStan, Pint, `dart analyze` and similar checkers, so a mistake shows up in the turn that made it.

## Install

Needs Bun and opencode v2. From a checkout of this repository:

```
bun opencode/ac/scripts/install.ts --dry-run
bun opencode/ac/scripts/install.ts
```

The installer moves an existing `~/.config/opencode` aside once (`opencode.bak-v1-<stamp>`) and writes `opencode.jsonc`, `cli.json` and a first-run `AGENTS.md` with placeholders for you to fill. Re-running it replaces only `opencode.jsonc`, `cli.json` and the agents link, and copies the first two to `.bak-<stamp>` first.

The default routing uses codefast.app endpoints (GLM, Kimi, DeepSeek, Qwen) with a Claude rung at the end of each chain. `--preset claude` puts Claude first through the built-in `anthropic` provider; `--preset gpt` and `--preset gpt-unlimited` route GPT through codefast. The web, docs and history tools come from the shared MCP server and need `KODIZM_MCP_TOKEN` in your environment.

## Keeping it in step

Every ported file under `agents/`, `skills/` and `templates/` starts with `<!-- ported-from: <source> sha256:<hash> -->`. `test/provenance.test.ts` fails when a source changes without its port being re-stamped, which is what keeps the two hosts from drifting:

```
bun opencode/ac/scripts/provenance.ts stamp <port> <source>
cd opencode/ac && bun run typecheck && bun test
```

Not ported, because opencode has no counterpart: the Claude Code hooks (their jobs are the plugin's guards), output styles, `ac:install`, `ac:init-project` and the prompt, skill, agent, command and CLAUDE.md authoring skills.
