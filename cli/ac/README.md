# ac CLI

Companion CLI runtime for the `ac` Claude Code plugin. Written in TypeScript, built with Bun, shipped as a Node-compatible bundle at `plugins/ac/cli/ac.js`.

## Roadmap

- Host MCP servers on the local machine.
- Run third-party AI CLIs (opencode, codex, others).
- Proxy the kodizm MCP server.

## Development

```sh
cd cli/ac
bun install
bun run start hello
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
