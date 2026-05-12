# ac

Structured development partner for Claude Code. Plans before coding, investigates bugs with hypothesis discipline, and delegates work to specialized agents.

## Layout

```
.claude-plugin/plugin.json    Plugin manifest.
agents/                       Subagents, one `.md` file per agent.
commands/                     Slash commands, one `.md` file per command.
skills/                       Skills, each in its own `<name>/SKILL.md` folder.
hooks/                        Hook configurations (optional `hooks.json`).
```

All component folders are auto-discovered by Claude Code. Override paths in `.claude-plugin/plugin.json` only when the defaults do not fit.

For the plugin specification, see the [Claude Code plugins reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference).
