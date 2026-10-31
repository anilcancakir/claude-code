# ac

Describe the change. `ac` researches it, builds it in slices on the cheapest model that can do each, checks the result with tests and an independent review, and keeps going while you are away.

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

`/ac:install` is optional and interactive; the [repo root README](../../README.md#install) says what it writes.

## What you get

- `ac:flow`, the default build flow for a medium or large request: parallel research, a short interview, slices on tiered workers, one review.
- `/ac:plan` and `/ac:execute` for a written plan run wave by wave, `/ac:auto` and `/ac:coordinate` for work that finishes while you are away, `/ac:qa` and `/ac:product` for QA and roadmaps.
- Thirteen agents, an opt-in `ac:concise` output style, hooks (eight gated to a run you started or to an `ac` subagent, thirteen registered for every session; the list is in [`docs/hooks.md`](docs/hooks.md)), and an MCP server: local history search, plus docs, code and web lookup through the kodizm service with a token.

The skill and agent tables, the hook list and the requirements are in the [repo root README](../../README.md).

## Component layout

| Directory | Contents |
|-----------|----------|
| `agents/` | Subagent definitions, one `.md` file per agent |
| `skills/` | Skills, each in its own `<name>/SKILL.md` folder; the slash commands `/ac:commit`, `/ac:init-project` and `/ac:install` are skills too |
| `output-styles/` | Output styles, one `.md` file per style; selectable, never forced |
| `hooks/` | Hook scripts plus the `hooks.json` registration that wires them |
| `cli/` | Bundled MCP runtime (`ac.js`); do not hand-edit, regenerate with `bun run build` |
| `references/` | Bundled references the skills read: the working rules, the verification guide, style and CLAUDE.md templates consumed by `/ac:install` |
| `docs/` | Human-facing guides: the hook list and the iTerm2 terminal setup |
| `evals/` | Agent eval cases and graders, run by `claude plugin eval` |

For the plugin specification, see the
[Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference).
