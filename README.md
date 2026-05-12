# ac marketplace

Claude Code plugin marketplace by Anilcan Cakir. Main `ac` plugin plus auxiliary plugins.

## Install

```
/plugin marketplace add anilcancakir/claude-code
/plugin install ac@ac
```

## Plugins

- `ac`: structured development partner for Claude Code.

## Layout

```
.claude-plugin/marketplace.json    Marketplace manifest.
plugins/
  ac/                              Main plugin.
    .claude-plugin/plugin.json
    agents/  commands/  skills/    Auto-discovered components.
references/                        Submoduled reference repositories.
```

## Adding a new plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json`.
2. Add the component folders you need (`agents/`, `commands/`, `skills/`, `hooks/`, `.mcp.json`).
3. Register the plugin in `.claude-plugin/marketplace.json` under `plugins[]`.

For the full specification, see the [Claude Code plugins reference](https://docs.anthropic.com/en/docs/claude-code/plugins-reference) and the [marketplace guide](https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces).
