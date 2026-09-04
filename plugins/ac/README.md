# ac

Claude Code plans the work, routes each step to the cheapest model that can do it, and verifies
four ways before calling it done.

Full docs: [repo root README](../../README.md)

## Component layout

| Directory | Contents |
|-----------|----------|
| `agents/` | Subagent definitions, one `.md` file per agent |
| `commands/` | Slash commands, one `.md` file per command |
| `skills/` | Skills, each in its own `<name>/SKILL.md` folder |
| `hooks/` | Hook scripts plus the `hooks.json` registration that wires them |
| `cli/` | Bundled MCP runtime (`ac.js`); do not hand-edit, regenerate with `bun run build` |
| `references/` | Bundled style and CLAUDE.md templates consumed by `/ac:install` |
| `evals/` | Agent eval cases and graders, run by `claude plugin eval` |

`agents/`, `commands/` and `skills/` are auto-discovered by Claude Code; override their paths in
`.claude-plugin/plugin.json` only when the defaults do not fit. Hooks are declared in
`hooks/hooks.json`. The last three are not components: `cli/` is loaded through `.mcp.json`,
`references/` is data the commands read at `${CLAUDE_PLUGIN_ROOT}`, and `evals/` is read by
`claude plugin eval`.

For the plugin specification, see the
[Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference).
