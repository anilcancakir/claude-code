# ac for OpenCode

OpenCode port of the research surface of the `ac` Claude Code plugin: the three research subagents, the operating-mode overlay, and the `ac` MCP server. The plan chain (`/ac:plan`, `/ac:execute`, workers, reviewers) is intentionally not ported.

## Layout

| Path | Purpose |
|---|---|
| `agents/explore.md` | Codebase research subagent. Overrides OpenCode's built-in `explore`. Pinned to `opencode-go/deepseek-v4-flash`. |
| `agents/librarian.md` | External docs and OSS research subagent. Pinned to `opencode-go/minimax-m2.7`. |
| `agents/oracle.md` | Strategic advisor subagent. Pinned to `opencode-go/qwen3.7-max`. |
| `plugins/append-system.ts` | Injects `append-prompt.md` into primary-agent system prompts; the `--append-system-prompt-file` equivalent. |
| `append-prompt.md` | Operating-mode overlay, adapted from `plugins/ac/append-prompt.md` for OpenCode tool names (`task`, `question`, `skill`, `lsp`, `ac_*` MCP tools). |

## Install

```bash
ln -s ~/Code/claude-code/opencode/agents ~/.config/opencode/agents
ln -s ~/Code/claude-code/opencode/plugins ~/.config/opencode/plugins
```

`~/.config/opencode/opencode.json` declares the `ac` MCP server (runs `node plugins/ac/cli/ac.js mcp` from this repo), disables the built-in `webfetch`, and keeps `share` disabled. `~/.config/opencode/package.json` pins `@opencode-ai/plugin` for the plugin's type imports.

Skills are not duplicated here; OpenCode reads `~/.claude/skills/` natively (my-coding, my-language, github-cli, and the rest).

## Differences from the Claude Code original

- Agent names drop the `ac:` prefix (`explore`, `librarian`, `oracle`); OpenCode namespaces by filename and the built-in `explore` is overridden by ours.
- `omitClaudeMd` has no OpenCode equivalent; global instructions reach every agent.
- Claude Code's `skills:` preload frontmatter has no equivalent; the `skills` map here only filters visibility.
- The overlay reaches `build` and `plan` agents through the plugin; subagent bodies are self-contained, same as the Claude Code wire contract.
- MCP tool names gain the server prefix: `web-fetch` becomes `ac_web-fetch`.
