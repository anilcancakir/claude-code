# Frontmatter Reference

Every field a Claude Code skill recognizes, what it does, when to set it, valid values, parsing pitfalls. Source of truth: [Anthropic docs](https://code.claude.com/docs/en/skills.md) and Claude Code's loader (`loadSkillsDir.ts:parseSkillFrontmatterFields`). When docs conflict with observed CLI behavior, trust the binary.

## Contents

- Required vs optional
- `name`
- `description` (recommended)
- `when_to_use`
- `argument-hint`
- `arguments`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `disallowed-tools`
- `model`
- `effort`
- `context`
- `agent`
- `background`
- `hooks`
- `paths`
- `shell`
- Agent Skills spec fields: `metadata`, `license`, `compatibility`
- Composite examples
- Parsing pitfalls

## Required vs optional

Only `description` is recommended; nothing is strictly required. Unknown fields are ignored, and the frontmatter is read only when `---` is the first line of the file. Every other field is opt-in, included only when the skill has a specific need that the default behavior does not cover.

- Omit `name`: the directory name is used as the slash-command identifier.
- Omit `description`: the loader falls back to the first paragraph of the body, which is almost always the wrong text for the trigger decision.
- Omit everything else by default. Each optional field below documents the specific condition that justifies adding it. If you cannot name the condition, do not set the field; the default behavior is the right one.

**The minimal frontmatter:**

```yaml
---
description: <what the skill does + when to use it>
---
```

That is enough for a reference skill. Most workflow skills add `when_to_use` for trigger phrasing. Anything more requires a justified condition (the skill genuinely takes input, has irreversible side effects, needs path-scoped activation, etc.).

**Anti-pattern: cargo-culting.** Copying every field from a template into a new skill "just in case" adds noise without behavior. Each unused field consumes attention from readers and can hide bugs (a stale `paths:` that no longer matches, an `allowed-tools:` list that drifted from the body's actual calls).

## `name`

Display name and slash-command identifier. Hard validation rules from the Agent Skills spec:

- Maximum 64 characters
- Lowercase letters, numbers, hyphens only
- No XML tags
- Reserved: the `anthropic-skills` namespace in Claude Code. The Claude API's skill upload also rejects names containing `anthropic` or `claude`, so avoid them in a skill meant for both.

If you set `name`, match it to the directory name. The slash command resolves from the directory name; the `name` field is the display name. Diverging on purpose causes user confusion ("I see `name: bar` but `/bar` does not work").

**Naming convention.** Anthropic recommends gerund form (`processing-pdfs`, `analyzing-spreadsheets`, `managing-databases`). Noun phrases (`pdf-processing`) and action-oriented (`process-pdfs`) are acceptable alternatives. Vague names (`helper`, `utils`, `tools`, `documents`, `data`) hurt discovery, the model cannot guess what they cover.

```yaml
name: processing-pdfs
```

## `description` (recommended)

What the skill does and when to use it. This is the selection mechanism. When the model has many skills, it picks based on this field alone. Validation rules:

- Non-empty string
- No XML tags

Two separate budgets govern visibility:

1. **Per-skill cap.** `description` + `when_to_use` combined is truncated at 1,536 characters in the listing. Configurable via the `skillListingMaxDescChars` setting.
2. **Total listing budget.** Across all listed skills, the listing budget scales at 1% of the model's context window. Configurable via `skillListingBudgetFraction` (e.g. `0.02` for 2%) or `SLASH_COMMAND_TOOL_CHAR_BUDGET` (fixed character override).

Every skill name is always listed. When the descriptions overflow the budget, the least-invoked skills lose theirs first; the skills you actually use keep their full text. `/skill-doctor` audits the installed skills. Front-load the use case so trailing words are not the ones lost.

**Three rules for the description text:**

1. **Imperative verb and object, like Claude Code's bundled skills.** "Create a git commit", "Review the changed code for reuse, simplification, efficiency", not "I can summarize PRs" or "You can use this to summarize PRs".
2. **What it does, then when.** `description` states the function; `when_to_use` is one "Use when..." sentence naming the situation, not a list of phrasings.
3. **Specific over generic.** "Helps with documents" loses to "Extract text and tables from PDFs, fill forms and merge files." Name the file type and the verbs once.

```yaml
description: "Summarize a GitHub pull request from its diff, comments and review threads."
when_to_use: "Use when the user asks what a PR changed or pastes a PR URL."
```

## `when_to_use`

One sentence that starts "Use when", appended after ` - ` in the listing and sharing the 1,536-character cap.

```yaml
when_to_use: "Use when a merged PR has to reach a release branch."
```

## `argument-hint`

Autocomplete hint shown after the slash command. Pure documentation, not validated.

```yaml
argument-hint: "[pr-number] [target-branch]"
```

## `arguments`

Named positional arguments enabling `$name` substitution in the body. Accepts a space-separated string or YAML list. Names map to positions in order; digit-only names are dropped, and the first 64 names of up to 64 characters are filled (2.1.301).

```yaml
arguments: [pr_number, target_branch]
# or
arguments: pr_number target_branch
```

In the body, `$pr_number` expands to the first argument, `$target_branch` to the second. `$0`, `$1`, and `$ARGUMENTS[0]`, `$ARGUMENTS[1]` work too. Argument design for typed workflows: `${CLAUDE_SKILL_DIR}/references/user-typed-skills.md`.

## `disable-model-invocation`

When `true`, the skill is hidden from the model's auto-invocation list. Only the user can trigger it via `/name`. The description does not consume context tokens.

```yaml
disable-model-invocation: true
```

Use for:

- Irreversible side effects (`/deploy`, `/commit`, `/send-slack`).
- User-only choreography (Skillify-style capture, `/init`).
- Skills noisy enough that the always-loaded description is not worth the budget.

Default `false`. Side effect: skills with this flag cannot be preloaded into a subagent via the agent's `skills:` field.

## `user-invocable`

When `false`, the skill is hidden from the `/` slash menu. Only the model can invoke it via auto-trigger.

```yaml
user-invocable: false
```

Use for background reference knowledge (`legacy-billing-context`) where typing `/legacy-billing-context` is not a meaningful user action. Default `true`.

The `user-invocable` field only controls menu visibility, not Skill-tool access. To block programmatic invocation by the model, use `disable-model-invocation: true`.

## `allowed-tools`

Tools pre-approved for the turn that invokes the skill, so the user is not prompted. Accepts space-separated string or YAML list. Use narrow `Tool(pattern:*)` rules, not bare tool names.

```yaml
allowed-tools: Bash(gh pr view:*) Bash(gh pr diff:*) Read Grep
# or
allowed-tools:
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git status:*)
  - Read
```

This grants permission; it does not restrict. Every tool stays callable; tools not listed still go through the user's permission settings, and deny rules still win. To take tools away, use `disallowed-tools`.

Pattern syntax mirrors `/permissions`:

- `Read`, `Grep`, etc., bare tool names allow all calls.
- `Bash(git status:*)`, the `:*` matches any arguments to that subcommand.
- `Bash(git status)`, exact match, no arguments.

## `disallowed-tools`

Tools removed while the skill is active (2.1.152). The removal is cleared on the next user message. Same list syntax as `allowed-tools`.

```yaml
disallowed-tools: Write Edit NotebookEdit
```

Use for a review or audit skill that must not edit, or a workflow where one tool would derail the run. It is turn-scoped, not a lasting boundary; a lasting one belongs in permissions or a subagent's tool list.

## `model`

Override the active model while the skill runs. Same values as `/model`, plus `inherit` (no override).

```yaml
model: opus
# or
model: sonnet
# or
model: inherit
```

Override applies for the rest of the current turn and is not saved. `inherit` keeps the session model. Session model resumes on the next user prompt. Useful for skills that need a heavier model than the session default (a deep refactor under a Haiku session) or a lighter one (boilerplate under an Opus session).

## `effort`

Override the active effort level while the skill runs. Options depend on the model: `low`, `medium`, `high`, `xhigh`, `max`.

```yaml
effort: high
```

Use when the skill needs a different reasoning budget than the session default, a complex audit skill at `high`, a quick formatter skill at `low`. Most skills inherit fine. Haiku 5.5 supports it (default `medium`); Haiku 4.5 does not support the parameter at all, so omit it on any skill targeted at that model. Detail on effort tuning: `${CLAUDE_SKILL_DIR}/references/opus-5-tuning.md`.

## `context`

When set to `fork`, the skill runs in a subagent. The body becomes the subagent's task prompt. The subagent does not see the parent conversation history.

```yaml
context: fork
agent: ac:explore
```

Inline (the default) keeps the work in the current conversation, which lets the user steer mid-process and lets the body reference earlier conversation state.

`fork` requires the body to be an actionable task. Reference material with no goal produces a subagent with guidelines and no instructions, then returns nothing useful.

## `agent`

Picks the subagent type when `context: fork` is set. Built-in options: `Explore`, `Plan`, `general-purpose`. Or any custom agent in `.claude/agents/<name>.md`. Defaults to `general-purpose`. A setup installed by `/ac:install` disables and denies the built-in `Explore` and `Plan` (`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1`, `Agent(Explore)`, `Agent(Plan)`), so name `ac:explore` or `general-purpose` there. An `agent:` value that names no loaded agent falls back to `general-purpose` with only a debug-log line, so a skill naming `ac:explore` runs on `general-purpose` for anyone without the ac plugin.

```yaml
context: fork
agent: ac:explore
```

The agent type determines the model, tools, and permissions of the subagent.

## `background`

Fork skills only. Whether the forked run goes to the background; default `true` since 2.1.218. Set `false` when the invoking turn needs the result before it continues.

```yaml
context: fork
background: false
```

## `hooks`

Hooks the skill registers when it is invoked. Same shape as project-level hooks settings. They stay registered for the rest of the session, not just while the skill runs; `once: true` on a hook removes it after its first run.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_SKILL_DIR}/scripts/audit_bash.sh"
```

Use when the skill needs deterministic enforcement that prompt instructions cannot guarantee (logging, gating destructive commands, compliance checks). Limits per source per session: 1,024 hooks and 16,384 matcher characters (2.1.304).

## `paths`

Glob patterns that limit auto-activation to sessions touching matching files. Accepts comma-separated string or YAML list. Uses gitignore-style matching, same syntax as CLAUDE.md path-specific rules.

```yaml
paths:
  - "lib/**/*.dart"
  - "pubspec.yaml"
# or
paths: "lib/**/*.dart, pubspec.yaml, test/**/*.dart"
```

The skill is stored as conditional and only activated when the model touches a matching file in the session. The loader drops `/**` suffixes (the ignore library matches directory paths both ways).

Useful in monorepos with technology-specific skills. Path-conditional skills are invisible to the description budget until activated.

## `shell`

Shell used for `` !`<command>` `` and ` ```! ` blocks in the body: `bash` (default) or `powershell`.

```yaml
shell: powershell
```

`powershell` is honored only on Windows when `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` is set. Cross-platform skills should leave this default and write portable shell.

## Agent Skills spec fields: `metadata`, `license`, `compatibility`

Fields from the Agent Skills open standard. Claude Code accepts them and acts on none; set them when the skill is also published for other agents. `compatibility` is capped at 500 characters.

```yaml
license: Complete terms in LICENSE.txt
compatibility: Requires git and gh on PATH.
metadata:
  author: example-org
```

## Composite examples

### Reference skill (always-on knowledge)

```yaml
---
name: api-conventions
description: API design conventions for this codebase. Triggers when writing or reviewing route handlers, controllers, OpenAPI specs, or anything under `app/Http/`. Use even when the user does not say "API".
paths:
  - "app/Http/**"
  - "routes/**"
  - "openapi/**"
---
```

Inline content the model applies alongside conversation. No fork, no allowed-tools, no arguments.

### Manual-only deploy skill (irreversible side effect)

```yaml
---
name: deploy
description: Deploys the application to production. Manual-only; the user invokes with `/deploy <env>`.
when_to_use: User-only command for shipping a build to production.
disable-model-invocation: true
argument-hint: "<staging|production>"
arguments: [env]
allowed-tools: Bash(./scripts/deploy.sh:*) Bash(gh release create:*)
context: fork
agent: general-purpose
---
```

Disable model invocation, take an argument, narrow tool whitelist, run forked because the work is self-contained.

### Background context skill (model-only)

```yaml
---
name: legacy-billing-system
description: Context on the legacy billing-v1 service so the model can reason about migrations away from it. Auto-loads when work touches `services/billing/legacy/` or anything that imports `legacy_billing`.
user-invocable: false
paths:
  - "services/billing/legacy/**"
---
```

Hidden from the slash menu (no meaningful user action), conditional on path so it does not bloat unrelated sessions.

### Forked research skill with arguments

```yaml
---
name: deep-research
description: Researches a topic thoroughly across the codebase. Use when the user asks "how does X work end-to-end", "where is X handled", or wants a deep audit of a feature.
context: fork
agent: ac:explore
argument-hint: "[topic or question]"
allowed-tools: Read Grep Glob
---
```

Fork to keep the main conversation clean, `ac:explore` for read-only investigation, narrow tool list.

### Plugin-distributed skill (portable bundled files)

```yaml
---
name: pdf-extractor
description: Extracts text and tables from PDF files. Triggers on "extract from PDF", "parse this PDF", "get the table from <file>.pdf", or any request that involves reading PDF content.
allowed-tools: Read Bash(python:*)
---

# PDF Extractor

Use the bundled script:

`!`python ${CLAUDE_SKILL_DIR}/scripts/extract_pdf.py "$ARGUMENTS"``

For schema details and edge cases (encrypted PDFs, scanned PDFs requiring OCR), read `${CLAUDE_SKILL_DIR}/references/pdf-schemas.md`.
```

Plugin skills must reference bundled files via `${CLAUDE_SKILL_DIR}/...`. Repo-relative paths break at install time because the destination path is unknown.

## Parsing pitfalls

- **YAML strings with colons.** Wrap in quotes: `description: "Use when X: this triggers"`.
- **Booleans.** `true`/`false`; `yes`/`no`, `on`/`off` and `1`/`0` also parse but obscure intent.
- **Frontmatter position.** The block is read only when `---` is line 1. A blank line or a comment above it turns the whole block into body text.
- **List vs string.** `allowed-tools: Read Grep` and `allowed-tools: [Read, Grep]` both work. Pick one for consistency.
- **Multiline strings.** Use `|` for literal newlines, `>` to fold:
  ```yaml
  when_to_use: |
    First trigger phrase.
    Second trigger phrase.
  ```
- **Indentation.** YAML is whitespace-sensitive. Two spaces, no tabs.
- **`name` collision.** When two non-plugin skills resolve to the same name, location precedence wins (managed > user > project). The other is silently skipped. Plugin skills live in their own namespace and never collide.
- **Path normalization.** The `paths:` parser strips `/**` suffixes and treats `**` alone as match-all (equivalent to no `paths:`). Use specific globs or omit the field.
- **Effort values.** Valid: `low`, `medium`, `high`, `xhigh`, `max`. Anything else logs a debug warning and falls back to inheritance.
- **`context` other than `fork`.** The loader only recognizes `fork`; any other value silently behaves as inline.
- **MCP skills.** Skills loaded via MCP servers cannot execute shell injection and `${CLAUDE_SKILL_DIR}` is meaningless for them. Author MCP skills assuming no preprocessing.
