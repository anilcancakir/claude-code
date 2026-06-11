# Contributing

Thank you for your interest in contributing to the `ac` plugin marketplace.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20 (runtime for the shipped MCP bundle)
- [Bun](https://bun.sh/) (build, typecheck, and test the CLI source at `cli/ac/`)
- [Claude Code](https://code.claude.com/) with the `ac` plugin installed for manual testing

## Dev setup

```sh
# Install CLI dependencies
cd cli/ac && bun install

# Build the shipped bundle (writes to plugins/ac/cli/ac.js)
cd cli/ac && bun run build

# Typecheck (strict mode, verbatimModuleSyntax)
cd cli/ac && bun run typecheck

# Run tests
cd cli/ac && bun test
```

The build is not automatic. Rebuild the bundle after every change to `cli/ac/src/` before testing
the plugin in Claude Code.

## PR checklist

- [ ] `bun run typecheck` exits clean (zero errors, zero warnings).
- [ ] `bun test` exits clean (all tests pass).
- [ ] If `cli/ac/` was touched, the bundle is rebuilt (`bun run build`) and `plugins/ac/cli/ac.js`
      is included in the commit.
- [ ] One concern per PR: a single bug fix, feature, or refactor. Mixed-scope PRs will be asked
      to split.

## Style

- All code, names, comments, docblocks, and commit messages: English only.
- No `// @ts-ignore`, `// eslint-disable`, or equivalent suppression. Fix the underlying issue.
- No `try/catch` that silently swallows errors. Either handle deliberately or let it propagate.
- No em-dash or en-dash anywhere (docs, comments, prose). Use commas, colons, or parentheses.
- TypeScript strict mode is enforced by `cli/ac/tsconfig.json`; do not loosen its settings.

## How to add a plugin

New plugins live under `plugins/<name>/` and register in `.claude-plugin/marketplace.json`.
See the root [README](README.md) for the component layout and the
[Claude Code plugins reference](https://docs.claude.ai/en/docs/claude-code/plugins-reference.md)
for the full specification.
