# Claude Code Mechanics

How the Claude Code runtime treats skills: where they load from, when they activate, what gets injected, how compaction handles them, what the trigger decision looks like. Read this when a skill misbehaves and you need to understand the runtime, or when deciding between structural options and the loader's actual reward matters.

Source of truth: [Anthropic docs](https://docs.claude.com/en/docs/claude-code/skills.md) plus Claude Code's loader (`loadSkillsDir.ts`) and `SkillTool.ts`. When docs conflict with observed CLI behavior, trust the binary.

## Contents

- Location and precedence
- Discovery
- What loads when
- The trigger decision
- The Skill tool (how the model invokes a skill)
- Auto-compaction
- String substitutions
- Shell injection
- Forked execution
- Tool pre-approval mechanics
- Workspace trust dialog
- Hooks in skills
- Description and `when_to_use` char budget
- `skillOverrides` setting (visibility control from settings)
- Plugin skills (namespace, paths, install destination)
- Path-conditional activation
- What the runtime does NOT do

## Location and precedence

The runtime walks five sources in this order. The first match wins for any given skill name:

1. **Managed**, enterprise-managed dir. Highest precedence.
2. **User**, `~/.claude/skills/<name>/SKILL.md`. Cross-project personal.
3. **Project**, `<repo>/.claude/skills/<name>/SKILL.md`, plus any nested `.claude/skills/` walked up from cwd.
4. **Plugin**, `<plugin>/skills/<name>/SKILL.md`. Always namespaced as `plugin-name:skill-name`, so it cannot collide with the others.
5. **Bundled**, built-in skills shipped with the CLI binary (`/skillify`, `/simplify`, `/verify`, `/debug`, etc.).

Names that collide across managed/user/project resolve in that order. Plugin skills live in their own namespace. Between `.claude/commands/<name>.md` and `.claude/skills/<name>/SKILL.md`, the skill wins.

The runtime deduplicates by resolved file path (via `realpath`), so symlinks pointing to the same file load once even if reachable through multiple sources.

## Discovery

At session start, the runtime scans:

- The managed dir, the user dir, every project dir from cwd walked up to home, and any `--add-dir` paths' `.claude/skills/`.
- Legacy `.claude/commands/` (still supported, treated as skills).
- The bundled registry (compiled into the binary).
- Any MCP server that registers a skill builder.

During a session:

- File watchers pick up edits, additions, and deletions in user/project/add-dir skill directories. Changes take effect within the session.
- When the model touches a file in a nested directory, the runtime walks up and discovers any `.claude/skills/` along the way (monorepo case).
- Conditional skills (with `paths:`) are stored at startup but only activated when the model touches a matching path.

A new top-level skills directory created mid-session does not auto-watch; the user must restart Claude Code so the watcher attaches.

## What loads when

Three layers, three lifetimes:

| Layer | When loaded | Cost |
|-------|-------------|------|
| Skill metadata (`name` + `description` + `when_to_use`) | Always in context | Tokens for each skill, capped per-skill at 1,536 chars; total listing scales at 1% of the model's context window. See the char-budget section below for overflow and override behavior. |
| Skill body | When the skill triggers (model auto-load or user `/name`) | Full body, once per invocation, into the conversation as a single message |
| `references/`, `scripts/`, `assets/` | Only if the body or a tool call reads them | Zero until referenced |

`disable-model-invocation: true` removes the metadata from the model's context entirely (only the user sees it in the slash menu). `paths:` defers the metadata to activation.

When the body is injected, the loader prepends `Base directory for this skill: <baseDir>\n\n` so the model knows where bundled files live. `${CLAUDE_SKILL_DIR}` in the body is then substituted to that base directory.

## The trigger decision

The model sees a list of available skill names + descriptions in its system context. When a user message arrives, it decides whether any skill matches before responding. Two practical consequences:

- **Description quality is everything.** The model never sees the body until it triggers, so the description has to do the work of advertising the skill to the right requests.
- **Simple requests bypass skills.** The runtime biases toward direct handling for one-step queries (`read this file`). Skills trigger reliably on substantive, multi-step, or specialized requests.

Triggering is decided per-turn. A skill that fired once does not stay loaded forever; if the conversation moves elsewhere and an auto-compact happens, the skill may drop. Re-trigger by asking again or by strengthening the description for higher recall.

## The Skill tool (how the model invokes a skill)

The model invokes a skill by calling the built-in Skill tool with `{skill: "<name>", args: "<optional>"}`. The tool description Claude Code injects (from `SkillTool.ts`) states:

- Plugin skills must use the fully qualified `plugin:skill` form.
- The model must invoke the Skill tool when a skill matches before generating any response about the task. This is a blocking requirement.
- The model must not invent skill names from training data; only invoke skills listed in the active skill listing.
- If a `<skill>` tag is already present in the current turn, the skill is already loaded; the model should follow its instructions directly rather than re-invoking.
- Built-in CLI commands (`/help`, `/clear`, etc.) are not Skill-tool targets.

The tool validates the skill exists, checks `disable-model-invocation`, runs permission checks (deny rules, allow rules, safe-property auto-allow, ask fallback), then either expands the body inline or runs the forked subagent.

## Auto-compaction

When the conversation approaches the context limit, the runtime summarizes prior turns and re-attaches recent skills. The rules:

- The most recent invocation of each skill is re-attached after the summary.
- Each re-attached skill keeps the first 5,000 tokens of its body.
- Re-attached skills share a 25,000-token combined budget, filled most-recent first.
- Older skills can drop entirely after compact if many were invoked.

Practical implications:

- **Body under 5,000 tokens** survives compact intact. Above that, the tail truncates.
- **Standing instructions belong at the top** of the body. The first 5,000 tokens are what survives.
- **Re-invoke after compact** if a skill seems to stop influencing behavior, the body may still be there, but the model is choosing other tools, or the body got cut.

After compact, Claude Code injects a system reminder noting which skills were invoked earlier in the session and warning the model not to re-execute their one-time setup actions (scheduling, file creation) and not to treat earlier `## Input` sections as the user's current message. Author skill bodies so re-attachment is safe: ongoing behavioral guidelines, not one-time triggers.

## String substitutions

The runtime substitutes these in the body before injection:

| Token | Expands to |
|-------|------------|
| `$ARGUMENTS` | full argument string after the slash command |
| `$ARGUMENTS[N]` | Nth positional, shell-quoted, 0-indexed |
| `$N` | shorthand for `$ARGUMENTS[N]` |
| `$<name>` | named arg from `arguments:` frontmatter list |
| `${CLAUDE_SKILL_DIR}` | absolute path to the skill's directory |
| `${CLAUDE_SESSION_ID}` | current session id |
| `${CLAUDE_EFFORT}` | active effort level (`low`/`medium`/`high`/`xhigh`/`max`) |

If `$ARGUMENTS` does not appear in the body and the user passed arguments, the runtime appends `ARGUMENTS: <input>` to the end so the model still sees them. This is a fallback; design the body to use the substitution explicitly.

Indexed args use shell-style quoting:

- `/my-skill "hello world" second` produces `$0` = `hello world`, `$1` = `second`.
- `$ARGUMENTS` always expands to the raw string as typed.

For plugin skills, `${CLAUDE_SKILL_DIR}` resolves to the skill's subdirectory inside the plugin (not the plugin root). It works in bash injection and in plain reference paths.

## Shell injection

Two forms run shell commands at substitution time, before the body is injected to the model:

**Inline**: `` !`<command>` `` is replaced with the command's stdout.

```markdown
PR diff: !`gh pr diff $pr_number`
```

**Fenced**: ` ```! ` blocks run multiple commands.

````markdown
```!
git status --short
git log --oneline -5
```
````

This is preprocessing. The model sees the output, not the command. Treat injection as part of authoring the prompt, not as something the model executes.

`shell:` frontmatter picks the shell (`bash` default, `powershell` on Windows when enabled). Bundled and managed skills can run injection regardless of policy; user, project, plugin, and additional-directory skills respect `disableSkillShellExecution: true` in settings. When disabled, commands are replaced with `[shell command execution disabled by policy]`.

`${CLAUDE_SKILL_DIR}` works inside injection, so a skill can call its own bundled scripts:

```markdown
Generate the report:
!`python ${CLAUDE_SKILL_DIR}/scripts/build_report.py "$ARGUMENTS"`
```

MCP-loaded skills cannot run shell injection, they are remote and untrusted. `${CLAUDE_SKILL_DIR}` is also meaningless for MCP skills.

**Footgun.** The preprocessor scans SKILL.md bytes with two regexes, neither of which respects markdown fences. Documenting a `` !`<cmd>` `` example or a ` ```! ` block inside a 4-backtick wrapper still triggers execution. When DOCUMENTING shell injection in a SKILL.md, escape the bang as `\!`. When USING it for real, plain `!` is correct.

## Forked execution

`context: fork` makes the body the prompt for a subagent. The runtime:

1. Picks the agent type from `agent:` (or `general-purpose`).
2. Creates an isolated context for the subagent.
3. Injects the body as the user task.
4. Loads CLAUDE.md as system context.
5. Runs the subagent until completion.
6. Returns the subagent's final response to the parent conversation as the skill output.

The parent conversation does not see the subagent's intermediate steps. The body must be a complete, self-contained prompt; the subagent has no access to anything the user said before.

The inverse is also possible: a subagent (defined in `.claude/agents/<name>.md`) can preload skills via its `skills:` field. The full body of each preloaded skill is injected into the subagent's context at startup. Skills with `disable-model-invocation: true` cannot be preloaded.

## Tool pre-approval mechanics

`allowed-tools:` adds `command: <patterns>` to the always-allow rules in the tool permission context for the duration of the skill's execution. It does not modify long-term settings.

The pattern syntax is the same as `/permissions`:

- `Read`, `Grep`, etc., bare tool names allow all calls.
- `Bash(git status:*)`, the `:*` matches any arguments to that exact subcommand.
- `Bash(git status)`, exact match, no arguments.

The user's deny rules still apply. A skill cannot pre-approve a tool the user has explicitly denied; the deny wins.

Skills with only "safe properties" (the loader's allowlist of read-side metadata fields) auto-allow without prompting. Any property outside that set with a meaningful value triggers the ask flow.

## Workspace trust dialog

For skills checked into a project's `.claude/skills/` directory, `allowed-tools` takes effect only after the user accepts the workspace trust dialog for that folder, the same gate that governs permission rules in `.claude/settings.json`. A repo can ship a skill that grants itself broad tool access; the trust dialog is the actual security boundary, not the project file system. The loader's invocation-time trust dialog is the enforcement point ([CC source](https://github.com/anilcancakir/claude-code-cli-source-code/blob/main/skills/loadSkillsDir.ts), comment near `isPathGitignored`).

User-scope skills (`~/.claude/skills/`), plugin skills, and bundled skills run under their own trust models and do not require the workspace dialog.

## Hooks in skills

Skill-scoped hooks fire while the skill is active. The events are the same as project hooks: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `SessionStart`, etc.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_SKILL_DIR}/scripts/audit.sh"
```

Use this when the skill must enforce something deterministically. Hooks run regardless of the model's reasoning. For static project-wide hooks, route through the `update-config` skill.

## Description and `when_to_use` char budget

Two separate budgets:

1. **Per-skill cap.** `description` + `when_to_use` are concatenated and truncated at **1,536 characters per skill** in the listing. Anything past that is invisible to the trigger decision. Configurable via the `maxSkillDescriptionChars` setting.
2. **Total listing budget.** Across all listed skills, the budget scales at **1% of the model's context window**. Configurable via `skillListingBudgetFraction` (e.g. `0.02` for 2%) or `SLASH_COMMAND_TOOL_CHAR_BUDGET` (fixed character count override).

When the total listing overflows, Claude Code drops descriptions for the least-used skills first; the skills you actually use keep their full text. Run `/doctor` to see whether the budget is overflowing and which skills lost their descriptions. To free budget for other skills, demote low-priority entries via `skillOverrides` (see below).

Front-load the use case in the first 700 to 900 characters of `description`. If the per-skill cap hits, the trailing text is what gets cut, not the front.

## `skillOverrides` setting (visibility control from settings)

`skillOverrides` controls skill visibility from settings (`.claude/settings.local.json` or any other settings scope), without editing the skill's own frontmatter. Useful for skills you do not own: shared project skills, skills provided by an MCP server. The `/skills` menu writes it for you (highlight a skill, press `Space` to cycle, `Enter` to save).

Four states per skill:

| Value | Listed to Claude | In `/` menu |
|-------|------------------|-------------|
| `"on"` (default for absent entries) | Name and description | Yes |
| `"name-only"` | Name only (frees description budget) | Yes |
| `"user-invocable-only"` | Hidden from Claude | Yes |
| `"off"` | Hidden from Claude | Hidden from menu |

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "off"
  }
}
```

Plugin skills are not affected by `skillOverrides`; manage those through `/plugin` instead.

## Plugin skills (namespace, paths, install destination)

Plugin skills behave like regular project skills with three differences:

1. **Namespace.** A plugin named `my-tools` containing a skill `cherry-pick` is invoked as `/my-tools:cherry-pick`, not `/cherry-pick`. The model must use the fully qualified `plugin:skill` form.
2. **Install destination is unknown at author time.** Repo-relative paths break. Reference bundled files only via `${CLAUDE_SKILL_DIR}/...`.
3. **`${CLAUDE_SKILL_DIR}` resolves to the skill's subdirectory inside the plugin**, not the plugin root. A skill at `<plugin>/skills/foo/SKILL.md` gets `${CLAUDE_SKILL_DIR}` = the absolute path to `<plugin>/skills/foo/`.

Plugin skills can use everything regular skills can use: `paths:`, `hooks:`, `context: fork`, scripts, references, assets.

## Path-conditional activation

Skills with `paths:` are stored when the session starts but invisible to the trigger decision. When the model touches a file matching one of the globs, the loader moves the skill from `conditionalSkills` to `dynamicSkills`, the description enters the listing, and the model can invoke it. Once activated within a session, the skill remains available even if subsequent reads do not match.

The matching syntax is gitignore-style. The loader drops `/**` suffixes (the ignore library matches both `lib/**` and `lib/` as the directory).

## What the runtime does NOT do

- **No re-read of SKILL.md after first invocation.** The body is injected once per invocation and stays in conversation. Edits to the file mid-session affect future invocations, not the current one.
- **No automatic argument validation.** `argument-hint:` is documentation. If the user passes the wrong number or shape of args, the body must handle it.
- **No type-checking of frontmatter.** Invalid fields are silently ignored or trigger a debug log; they do not stop the skill from loading.
- **No magic when triggering.** The model decides; the runtime delivers. If the description is weak, the skill stays cold.
- **No `${CLAUDE_SKILL_DIR}` substitution for MCP skills.** MCP-loaded skills are remote; the substitution is meaningless and shell injection is skipped entirely.
- **No silent generalization of rules across sections.** Opus 4.7 takes instructions literally, the body must state scope explicitly.
