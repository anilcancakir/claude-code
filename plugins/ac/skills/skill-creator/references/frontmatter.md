# Frontmatter Reference

Every field a Claude Code skill recognizes, what it does, when to set it, valid values, parsing pitfalls. Source of truth: [Anthropic docs](https://docs.claude.com/en/docs/claude-code/skills.md) and Claude Code's loader (`loadSkillsDir.ts:parseSkillFrontmatterFields`). When docs conflict with observed CLI behavior, trust the binary.

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
- `model`
- `effort`
- `context`
- `agent`
- `hooks`
- `paths`
- `shell`
- `version`
- `license`
- Composite examples
- Parsing pitfalls

## Required vs optional

Only `description` is recommended; nothing is strictly required. Every other field is opt-in, included only when the skill has a specific need that the default behavior does not cover.

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
- Reserved words forbidden: `anthropic`, `claude` (`claude-helper`, `anthropic-tools` will be rejected)

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

1. **Per-skill cap.** `description` + `when_to_use` combined is truncated at 1,536 characters in the listing. Configurable via the `maxSkillDescriptionChars` setting.
2. **Total listing budget.** Across all listed skills, the listing budget scales at 1% of the model's context window. Configurable via `skillListingBudgetFraction` (e.g. `0.02` for 2%) or `SLASH_COMMAND_TOOL_CHAR_BUDGET` (fixed character override).

When the listing overflows, Claude Code drops descriptions for the least-used skills first; the skills you actually use keep their full text. Run `/doctor` to confirm whether the listing budget is overflowing. Front-load the use case so trailing keywords are not the ones lost.

**Three rules for the description text:**

1. **Third person, present tense, active voice.** "Summarizes pull requests", not "I can summarize PRs" or "You can use this to summarize PRs".
2. **What it does + when to use it.** Both halves matter. "Summarizes a PR" tells the model the function; "Use when the user asks to summarize a PR, says 'review this PR', or pastes a PR URL" tells the model when to fire.
3. **Specific over generic.** "Helps with documents" loses to "Extracts text and tables from PDF files, fills forms, merges multi-page PDFs". Include the file types, the verbs, the trigger phrases.

```yaml
description: Summarizes a GitHub pull request with diff, comments, and review threads. Use when the user asks to "summarize this PR", "review this PR", "what changed in #123", or pastes a PR URL.
```

## `when_to_use`

Additional trigger context: phrasings, examples, contexts. Appended to `description` in the listing and shares the 1,536-character cap.

```yaml
when_to_use: |
  Use when the user wants to cherry-pick a PR to a release branch.
  Examples: "cherry-pick to release", "CP this PR", "hotfix this".
  Also triggers on "backport <issue>" or "ship this to the release branch".
```

Useful when `description` is already busy with the what-it-does and you want a separate slot for triggers.

## `argument-hint`

Autocomplete hint shown after the slash command. Pure documentation, not validated.

```yaml
argument-hint: "[pr-number] [target-branch]"
```

## `arguments`

Named positional arguments enabling `$name` substitution in the body. Accepts a space-separated string or YAML list. Names map to positions in order.

```yaml
arguments: [pr_number, target_branch]
# or
arguments: pr_number target_branch
```

In the body, `$pr_number` expands to the first argument, `$target_branch` to the second. `$0`, `$1`, and `$ARGUMENTS[0]`, `$ARGUMENTS[1]` work too.

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

Tools pre-approved while the skill is active so the user is not prompted. Accepts space-separated string or YAML list. Use narrow `Tool(pattern:*)` rules, not bare tool names.

```yaml
allowed-tools: Bash(gh pr view:*) Bash(gh pr diff:*) Read Grep
# or
allowed-tools:
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git status:*)
  - Read
```

This grants permission; it does not restrict. Every tool stays callable; tools not listed still go through the user's permission settings. To deny tools, use the permission system, not this field.

Pattern syntax mirrors `/permissions`:

- `Read`, `Grep`, etc., bare tool names allow all calls.
- `Bash(git status:*)`, the `:*` matches any arguments to that subcommand.
- `Bash(git status)`, exact match, no arguments.

## `model`

Override the active model while the skill runs. Same values as `/model`, plus `inherit` (no override).

```yaml
model: claude-opus-4-7
# or
model: claude-sonnet-4-6
# or
model: inherit
```

Override applies for the rest of the current turn and is not saved. Session model resumes on the next user prompt. Useful for skills that need a heavier model than the session default (a deep refactor under a Haiku session) or a lighter one (boilerplate under an Opus session).

## `effort`

Override the active effort level while the skill runs. Options depend on the model: `low`, `medium`, `high`, `xhigh`, `max`.

```yaml
effort: high
```

Use when the skill needs a different reasoning budget than the session default, a complex audit skill at `high`, a quick formatter skill at `low`. Most skills inherit fine. Detail on effort tuning: `${CLAUDE_SKILL_DIR}/references/opus-4-7-tuning.md`.

## `context`

When set to `fork`, the skill runs in a subagent. The body becomes the subagent's task prompt. The subagent does not see the parent conversation history.

```yaml
context: fork
agent: Explore
```

Inline (the default) keeps the work in the current conversation, which lets the user steer mid-process and lets the body reference earlier conversation state.

`fork` requires the body to be an actionable task. Reference material with no goal produces a subagent with guidelines and no instructions, then returns nothing useful.

## `agent`

Picks the subagent type when `context: fork` is set. Built-in options: `Explore`, `Plan`, `general-purpose`. Or any custom agent in `.claude/agents/<name>.md`. Defaults to `general-purpose`.

```yaml
context: fork
agent: Explore
```

The agent type determines the model, tools, and permissions of the subagent.

## `hooks`

Hooks scoped to this skill's lifecycle. Same shape as project-level hooks settings, but only fire while the skill is active.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_SKILL_DIR}/scripts/audit_bash.sh"
```

Use when the skill needs deterministic enforcement that prompt instructions cannot guarantee (logging, gating destructive commands, compliance checks).

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

Shell used for `` !`<command>` `` and ` ```! ` blocks in the body. Default `bash`.

```yaml
shell: powershell
```

`powershell` is honored only on Windows when `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` is set. Cross-platform skills should leave this default and write portable shell.

## `version`

Free-form version string. Documented in the parser but not consumed by triggering. Use for your own bookkeeping.

```yaml
version: "1.2.0"
```

## `license`

Free-form license string, surfaced in some loaders.

```yaml
license: Complete terms in LICENSE.txt
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
agent: Explore
argument-hint: "[topic or question]"
allowed-tools: Read Grep Glob
---
```

Fork to keep the main conversation clean, Explore agent for read-only investigation, narrow tool list.

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
- **YAML booleans.** Plain `true`/`false`. `yes`/`no`/`on`/`off` also parse but obscure intent.
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
