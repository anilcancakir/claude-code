# ac CLI

The runtime behind the `ac` Claude Code plugin. It serves the plugin's MCP tools, checks and prices plans and runs, and keeps a searchable archive of your own Claude Code history. Written in TypeScript, built with Bun, shipped as a Node-compatible bundle at `plugins/ac/cli/ac.js`.

## Commands

| Command | What it does |
|---------|--------------|
| `ac mcp` | Runs the stdio MCP server that Claude Code loads through `plugins/ac/.mcp.json`. `--client opencode` words the web tools without naming Claude Code built-ins. |
| `ac plan-scaffold <slug>` | Creates `.ac/plans/<slug>/` with `research/` and `evidence/` and a `plan.md` skeleton; leaves an existing `plan.md` untouched. |
| `ac plan-check <slug>` | Validates a plan's machine-readable shape (step checkboxes, Type, Tier, Commands, Evidence). Exits 1 on a malformed plan, 2 on a missing one. |
| `ac plan-stats` | Scans a directory tree for plans and prints tier and codebase-state distributions, retry rungs and remediation lines. |
| `ac run-stats <session>` | Prints the cost anatomy of one run from its session transcript: turns, tokens, context, compactions, tool mix, per-agent rollup. |
| `ac cost` | Prices what ac runs cost across every session transcript, by main thread and subagent type. `--days`, `--since`, `--project` and `--all-sessions` narrow it. |
| `ac lease add\|release\|sweep` | Records test resources a session started (a pid, an Android emulator, an iOS simulator, a playwright-cli session) and stops them at session end or the next session start. |
| `ac history index` | Builds or refreshes the local history archive from `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`). |
| `ac history search <pattern>` | Full-text search over the archive, with Turkish folding, from the shell. It is the command-line twin of the `search-history` MCP tool. |
| `ac history forget` | Deletes archive rows by `--session`, `--project` or `--before`; there is no wholesale wipe. |

## MCP tools

`ac mcp` serves six tools. Five proxy to the kodizm MCP server (`https://mcp.kodizm.com`, overridable with `--url`, authenticated by `--token` or `KODIZM_MCP_TOKEN`): `resolve-library`, `search-docs`, `web-code-search`, `web-search` and `web-fetch`. Without a token, `web-fetch` still works through a local fetch and the other four report that the remote is not configured. The sixth, `search-history`, runs locally against the history archive and never sends a transcript anywhere.

## Development

```sh
cd cli/ac
bun install
bun run start --help
```

`bun run dev` watches `src/` and reruns on change.

## Build

```sh
bun run build
```

Bundles `src/index.ts` into `plugins/ac/cli/ac.js` with a `#!/usr/bin/env node` shebang and `0o755` permissions. The build output is committed so plugin users do not need Bun or a build step.

## Typecheck

```sh
bun run typecheck
```

Runs `tsc --noEmit`. Must pass with zero errors before any commit.

## Test

```sh
bun test
bun run test:node
```

`bun test` runs the main suite. `test:node` runs the `*.node-check.ts` suites under Node, which the `node:sqlite` archive needs and bun cannot load.
