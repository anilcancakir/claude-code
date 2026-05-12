# Command vs Skill

Claude Code merged custom commands into the skill system: a file at `.claude/commands/<name>.md` and a skill at `.claude/skills/<name>/SKILL.md` both produce the same `/name` slash command and route through the same loader. The distinction is one of file shape and intended use, not runtime mechanics. Read this when deciding which storage format to use for a new command.

Source of truth: [Anthropic skills docs](https://docs.claude.com/en/docs/claude-code/skills.md), `loadSkillsDir.ts` and `utils/markdownConfigLoader.ts` in CC source.

## Contents

- TL;DR
- The two file shapes
- What each shape gains and loses
- Frontmatter parity
- The merged-into-skills nuance
- Plugin namespacing
- Migration path
- Decision rule

## TL;DR

Use flat `<scope>/.claude/commands/<name>.md` when the body is self-contained: a context-gathering recipe, a simple action, a single-script orchestration. No bundled files, no `${CLAUDE_SKILL_DIR}` resolution needed.

Use skill-directory `<scope>/.claude/skills/<name>/SKILL.md` when the command needs `references/`, `scripts/`, or `assets/` alongside it. `${CLAUDE_SKILL_DIR}` resolves to the skill's directory and lets you reference bundled files portably.

Both produce the same `/name` invocation. Both auto-namespace as `plugin:name` when shipped via a plugin.

## The two file shapes

### Flat: `commands/<name>.md`

```
my-project/.claude/commands/
├── commit.md
├── deploy.md
└── pr-summary.md
```

One file per command. The file's frontmatter and body are the whole command. Directory structure: none.

For plugins: `<plugin>/commands/<name>.md`. Same shape, just shipped via the plugin.

### Skill-directory: `skills/<name>/SKILL.md`

```
my-project/.claude/skills/cherry-pick-to-release/
├── SKILL.md
├── references/
│   ├── conflict-resolution.md
│   └── release-checklist.md
└── scripts/
    └── verify-release.sh
```

A directory per command. `SKILL.md` is the entrypoint. Bundled files (references, scripts, assets) live alongside.

For plugins: `<plugin>/skills/<name>/SKILL.md`. Same shape.

## What each shape gains and loses

| Capability | Flat | Skill-directory |
|------------|------|-----------------|
| Storage cost | One file | Directory with multiple files |
| `${CLAUDE_SKILL_DIR}` substitution | No (baseDir not set) | Yes (resolves to the skill's dir) |
| `${CLAUDE_PLUGIN_ROOT}` substitution (plugin commands only) | Yes (resolves to plugin root) | Yes (resolves to plugin root) |
| Bundle reference docs | Have to inline; for plugins, reference via `${CLAUDE_PLUGIN_ROOT}/...` is the workaround | Drop into `references/`, point body at `${CLAUDE_SKILL_DIR}/references/X.md` |
| Bundle scripts | Have to inline or reference an external script (plugin: via `${CLAUDE_PLUGIN_ROOT}`) | Drop into `scripts/`, run via `${CLAUDE_SKILL_DIR}/scripts/X.sh` |
| Bundle templates / assets | Have to inline (plugin: `${CLAUDE_PLUGIN_ROOT}/assets/X`) | Drop into `assets/` |
| Progressive disclosure (load only what's needed) | All-or-nothing (body either contains the content or not) | Body loads at trigger, references load on demand |
| Body size discipline | Small, since there's no escape | Easier to keep body under 500 lines by pushing detail to references |
| Migration from legacy `.claude/commands/` | Already there | Move file into a directory, rename to SKILL.md |
| File watcher behavior | Same | Same (CC watches both) |

Important caveat on the substitution rows: `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PLUGIN_ROOT}` only substitute in plugin contexts via `utils/plugins/loadPluginCommands.ts`. For non-plugin skills (under `.claude/skills/` or `~/.claude/skills/`), `${CLAUDE_PLUGIN_ROOT}` stays literal because the non-plugin loader (`loadSkillsDir.ts`) does not substitute it. If your command lives in a non-plugin scope and you need a path token, only `${CLAUDE_SKILL_DIR}` works.

## Frontmatter parity

Both shapes accept the same frontmatter fields. The list (full reference in `ac:skill-creator`'s `references/frontmatter.md`):

`name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `effort`, `context`, `agent`, `paths`, `hooks`, `shell`, `version`, `license`.

The runtime treats flat commands and skill-directory commands identically except for the `${CLAUDE_SKILL_DIR}` substitution.

## The merged-into-skills nuance

Historically Claude Code had `.claude/commands/<name>.md` (flat) as the only way to write a custom command. With the introduction of skills, the loader was unified: both paths register a `prompt`-type entry in the command registry, both go through `loadSkillsDir.ts`, both fire shell injection and argument substitution.

This has practical consequences:

- Anthropic docs now route the "slash commands" topic to the [skills docs](https://docs.claude.com/en/docs/claude-code/skills.md). The "slash commands" page redirects to skills.
- If you have both `.claude/commands/foo.md` and `.claude/skills/foo/SKILL.md`, the skill takes precedence (per `loadSkillsDir.ts` precedence logic).
- New plugins should prefer the skill-directory format. The flat `commands/` format is supported indefinitely for backwards compatibility but does not gain new features.

What still distinguishes a "command" from a "reference skill" in practice is the BODY SHAPE: command bodies tend to be phase-based, take arguments, use shell injection heavily, and have approval gates. Reference skills tend to be loaded for context and have no executable steps. The frontmatter and file location are the same.

## Plugin namespacing

For plugins, both shapes produce auto-namespaced slash commands. Plugin `my-plugin` containing `commands/cherry-pick.md` or `skills/cherry-pick/SKILL.md` invokes as `/my-plugin:cherry-pick`. The namespace prefix is set by the plugin manifest's `name` field.

Bare names (`/cherry-pick`) do not resolve once the command ships via a plugin; the model and user must use the fully qualified form.

Plugin-installed commands have access to:

- `${CLAUDE_SKILL_DIR}` for skill-directory format (resolves to the skill's directory within the installed plugin).
- `${CLAUDE_PLUGIN_ROOT}` IS substituted in plugin command/skill bodies (`utils/plugins/loadPluginCommands.ts:339-343`). Resolves to the plugin's root directory. Use this when a flat plugin command needs to reference a file outside its own directory (a shared template at `<plugin>/templates/X.md` is reachable via `${CLAUDE_PLUGIN_ROOT}/templates/X.md`). It is also substituted in hook commands, MCP configs, and LSP configs.
- `${user_config.X}` substitutes per-plugin user configuration values declared in the plugin manifest. Sensitive keys resolve to a placeholder.

## Migration path

To convert a flat command into the skill-directory format:

1. Create the directory: `mkdir .claude/skills/<name>/`.
2. Move the file: `mv .claude/commands/<name>.md .claude/skills/<name>/SKILL.md`.
3. Add bundled files alongside as needed (`references/`, `scripts/`, `assets/`).
4. Update the body to reference bundled files via `${CLAUDE_SKILL_DIR}/...`.
5. Optional: remove the original `.claude/commands/<name>.md` to avoid duplication. The skill takes precedence either way, but the flat file becomes dead weight.

The slash invocation stays the same. No code change.

## Decision rule

Pick the format by answering one question: **does the body need to reference any file outside itself?**

- No: flat `.md`. Simpler, fewer moving parts.
- Yes: skill-directory. The body can point at `${CLAUDE_SKILL_DIR}/references/X.md` or run `${CLAUDE_SKILL_DIR}/scripts/X.sh`, and everything stays portable across installs.

When in doubt, start flat. Migrating to skill-directory later is one `mv` command.
