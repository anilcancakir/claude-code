# ac

Plan-first development partner for Claude Code: interview-driven plans, tier-routed agents
(haiku/sonnet/opus), and an adversarial review chain that verifies through real usage.

Full docs: [repo root README](../../README.md)

## Component layout

| Directory | Contents |
|-----------|----------|
| `agents/` | Subagent definitions, one `.md` file per agent |
| `commands/` | Slash commands, one `.md` file per command |
| `skills/` | Skills, each in its own `<name>/SKILL.md` folder |
| `cli/` | Bundled MCP runtime (`ac.js`); do not hand-edit, regenerate with `bun run build` |
| `references/` | Bundled style and CLAUDE.md templates consumed by `/ac:install` |

All component folders are auto-discovered by Claude Code. Override paths in
`.claude-plugin/plugin.json` only when the defaults do not fit.

For the plugin specification, see the
[Claude Code plugins reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference).
