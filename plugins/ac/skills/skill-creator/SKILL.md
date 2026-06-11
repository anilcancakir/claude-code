---
name: skill-creator
description: Authors Claude Code skills (`.claude/skills/<name>/SKILL.md`, project/user/plugin/managed scope). Use whenever a new skill is being written, an existing skill is being edited, a recurring workflow is being captured as a playbook, scope and invocation are being decided (inline vs forked, model-invocable vs user-only), `allowed-tools` patterns are being chosen, bundled `references/` or `scripts/` are being added, `paths:` is being scoped, or a skill that fails to trigger is being debugged. Triggers on "create a skill", "write a SKILL.md", "turn this into a skill", "make a slash command", "package this workflow", "playbook", "fix this skill", "skill not triggering", "skillify". Use even when the user does not say the word "skill" but is asking to capture a procedure they keep retyping. Pair with `ac:prompt-writer` for the body content, with `command-creator` for command-shaped skills (`/name [args]`), with `agent-creator` for context-isolated workers, with `ac:claude-md-rules-creator` for facts that belong in CLAUDE.md instead. Target is Opus 4.8; Sonnet 4.6 follows the same shape at lower effort. Undertriggering is the failure mode, lean in when the request is plausibly about authoring or fixing a skill.
when_to_use: Creating, editing, auditing, or debugging any Claude Code skill at any scope.
disable-model-invocation: true
---

# Skill Creator

You are about to write or edit a skill another Claude will load. A skill is a directory with a `SKILL.md`. Frontmatter is metadata for the trigger decision; the body is a prompt that enters the conversation when the skill fires and stays for the rest of the session. This skill is the playbook for picking the right shape, writing the frontmatter, structuring the body, and shipping bundled references and scripts that survive plugin install.

Target is Opus 4.8. Same rules work for Sonnet 4.6 and Haiku 4.5 with lower effort levels. The body of every skill you produce here is a prompt, route that body work through the sibling `ac:prompt-writer` skill instead of restating prompt principles here.

## Two jobs, not one

Writing a skill splits cleanly into two tasks, and conflating them is the most common authoring mistake.

1. **Skill shape.** Frontmatter, file layout, scope, invocation control, bundling. This file teaches that.
2. **Body content.** The markdown the model reads when the skill triggers. This is a prompt. Route through `ac:prompt-writer` (architecture, snippets, anti-patterns, Opus 4.8 tuning).

The shape decisions front-load most of the leverage. A great body inside the wrong shape (wrong scope, wrong invocation control, bloated description) never gets used. A modest body inside the right shape gets used every day.

## Decision flow

Route by the user's request. Each branch lands on the right reference for the depth.

```
Is a skill the right tool at all?
├── Single fact that never changes → CLAUDE.md, route through `ac:claude-md-rules-creator`. Not a skill.
├── Truly one-off task → just do it. Not a skill.
├── Determinism that the body cannot guarantee → hook, not skill. Route through `update-config`.
├── Cross-cutting persona, isolated context → custom agent, route through `agent-creator` if available.
└── Recurring playbook, procedure, or knowledge → SKILL is the right tool, continue.

Is it user-driven `/name [args]` with arguments, often `disable-model-invocation: true`?
├── YES → use this skill for shape, then specialize through `command-creator` if available
│         (argument design, shell injection, built-in command patterns).
└── NO  → continue with this skill alone.

Is this an audit or fix of an existing skill?
├── YES → `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` first, then
│         `${CLAUDE_SKILL_DIR}/references/claude-code-mechanics.md` if behavior is unclear.
└── NO  → walk the Workflow below.
```

When the path runs through `command-creator`, `agent-creator`, or `ac:claude-md-rules-creator`, do both: invoke the matching creator for shape (if it is available in the session), keep this skill loaded for the parts that are still skill-shaped.

## Core principles

Eight rules that change outcomes the most. Detail in the references.

1. **Concise is the contract.** The body shares the context window with the system prompt, every other invoked skill, the conversation, and the user's actual request. Default to "Claude is already smart", only add what it would not know without you. Challenge each paragraph against "does this justify its tokens?"

2. **Match freedom to fragility.** Three settings: high freedom (text instructions, multiple valid paths, code review, exploration), medium freedom (parameterized scripts with a preferred pattern, report generation), low freedom (specific commands, fixed sequences, migrations, deploys). Over-constraining open fields wastes tokens; under-constraining narrow bridges breaks production.

3. **The description is the selection mechanism.** When the model has 100+ skills available, it picks based on `description` alone. Front-load the verb and noun, write third person ("Processes Excel files"), include trigger phrases, cover synonyms, be a little pushy. Modern Claude undertriggers skills, so lean toward catching the request.

4. **Progressive disclosure is the structural superpower.** Metadata always loaded, body on trigger, `references/` and `scripts/` only when the body points at them. Use this: keep the body lean, push detail into one-level-deep references, anchor each with "read this when X". Two-level-deep references suffer because the model often previews intermediate files with `head -100`.

5. **Standing instructions, not turn-scoped phrasing.** The body enters the conversation as a single message and stays for the rest of the session. Claude does not re-read SKILL.md. "Always use the bundled script" lasts; "for this turn, use the bundled script" rots by turn three.

6. **State scope explicitly.** Opus 4.8 takes instructions literally and will not silently generalize a rule across sections. Write "apply to every step, not just the first" when the rule must hold throughout.

7. **No aggressive caps.** "CRITICAL", "you MUST", "ALWAYS" in modern Claude produce weird compliance behaviors and overtriggering. Plain instructions work; if a rule needs weight, explain the why.

8. **The colleague test.** Re-read the body as if you had never seen the conversation. If a fresh reader would be confused, the model will be too.

## Where skills live

| Scope | Path | Reach | Default for |
|-------|------|-------|-------------|
| Managed | enterprise managed dir | All users in the org. Highest precedence. | Org-wide policy and compliance |
| User | `~/.claude/skills/<name>/SKILL.md` | All projects on this machine. | Cross-repo personal workflows |
| Project | `.claude/skills/<name>/SKILL.md` (walks up from cwd) | This repo only. Commit to share. | Repo-specific workflows |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Wherever the plugin is installed. Auto-namespaced as `plugin:skill`. | Distributing to others |

Precedence is managed > user > project; plugin skills live in their own namespace and never collide. Plugin skills must reference bundled files via the skill-directory token, never via repo-relative paths, because the install destination is unknown at author time. The token resolves to the skill's subdirectory inside the plugin, not the plugin root. See [Anthropic docs](https://docs.claude.com/en/docs/claude-code/skills.md) for the full substitution table.

## Frontmatter is minimal by default

The only fields a working skill needs are `name` and `description`. `when_to_use` is optional but usually worth adding. Everything else is opt-in: each optional field exists because some skills hit a specific condition that requires it. Add a field only when you can name the condition; otherwise leave it out and let the default behavior apply.

| Field | Required? | Default | Add when... |
|-------|-----------|---------|-------------|
| `name` | recommended (falls back to directory) | directory name | almost always; only omit when the directory name is already the right slug |
| `description` | recommended | first paragraph of body (usually wrong) | always |
| `when_to_use` | optional | empty | the description is busy and trigger phrases need a separate slot; usually worth setting |
| `argument-hint` | optional | none | the skill takes positional arguments and you want autocomplete to hint at them |
| `arguments` | optional | none | the skill takes input and you want named-positional substitutions (`$pr_number` instead of `$0`) |
| `disable-model-invocation` | optional | `false` | the skill has irreversible side effects (`/deploy`, `/commit`, `/send-slack`); user must trigger explicitly |
| `user-invocable` | optional | `true` | the skill is background reference knowledge that has no meaningful slash-menu invocation |
| `allowed-tools` | optional | none (every tool call goes through normal permissions) | the body issues specific tool calls you want pre-approved to avoid prompting (narrow patterns only) |
| `context` | optional | `inline` | the work is bounded, self-contained, and benefits from running in an isolated subagent context |
| `agent` | optional (only meaningful with `context: fork`) | `general-purpose` | a different subagent type (Explore, Plan, custom) fits the task better |
| `paths` | optional | none (skill always discoverable) | the skill is relevant only to a subset of files; you want to keep the description out of unrelated sessions' budget |
| `model` | optional | inherit session model | the skill needs a heavier or lighter model than the session default |
| `effort` | optional | inherit session effort | the skill needs more or less reasoning budget than the session default |
| `hooks` | optional | none | the skill needs deterministic enforcement that body instructions cannot guarantee (logging, gating destructive commands) |
| `shell` | optional | `bash` | the skill runs PowerShell on Windows |
| `version` | optional | none | you want your own bookkeeping |

Anti-pattern: copying every optional field from a template into a new skill "just in case". Each unused field adds noise without behavior. A reference skill with conventions for your codebase usually needs just `name` + `description` + `when_to_use`. A simple task skill adds `argument-hint` + `arguments` and that is often enough. Reach further into the table only when the skill's specific behavior demands it.

> **Escape convention used in this documentation.** This SKILL.md is itself a skill body that the Claude Code loader preprocesses. Any literal full-arguments token, skill-directory token, or session-id token (a plain dollar sign followed by the placeholder name) written here would be substituted by the loader on every invocation, corrupting the documentation. To prevent that, the docs below render those tokens with the HTML entity `&#36;` standing in for the dollar sign: you read `&#36;ARGUMENTS`, the loader sees `&#36;ARGUMENTS` and skips substitution, the model interprets the entity as `$` and reads the intended token. In your own skill bodies, drop the entity and write a plain dollar sign.

## Who invokes it

The default works for most skills: both the user (via `/name`) and the model (via auto-load) can invoke. Override only when there is a specific reason.

| Frontmatter | User can `/name` | Model auto-loads | Add when... |
|-------------|------------------|------------------|-------------|
| (defaults) | yes | yes | most skills, including all reference content and most workflow skills |
| `disable-model-invocation: true` | yes | no | the skill has irreversible side effects (`/deploy`, `/commit`, `/send-slack`); you do not want the model deciding to fire it |
| `user-invocable: false` | no | yes | the skill is background reference knowledge (a `legacy-billing-context` skill) where typing `/legacy-billing-context` is not a meaningful action |
| both | no | no | rare: a hidden helper activated only via `paths:` or by another skill referencing it |

## Inline or forked

Inline is the default and the right choice for most skills. Set `context: fork` only when the work is bounded, the body is an actionable task, and you do not need the user to steer mid-process.

| Decision | Inline (default, most skills) | Forked (`context: fork`, opt-in) |
|----------|-------------------------------|----------------------------------|
| Conversation history | Available | Not available |
| User can steer mid-process | Yes | No |
| Body shape allowed | Reference content or task | Actionable task only |
| Main context cleanup | No | Yes, work happens in an isolated context |
| `agent:` field | Ignored (do not set) | Picks subagent type (`Explore`, `Plan`, `general-purpose`, or any `.claude/agents/<name>.md`); only set when forking |

Reference content in a forked skill produces a subagent with guidelines but no goal, returning nothing useful. If the body has no actionable task, leave the default inline.

## Arguments

Skip this section if the skill takes no input from the user. Most reference skills (conventions, style guides) and many task skills (audits that operate on session state) need no arguments at all.

Set `arguments:` and `argument-hint:` only when the skill genuinely takes input (a PR number to cherry-pick, a topic to research, a path to extract from). The loader substitutes tokens at injection time, before the model sees the text. Per the escape convention above, the docs show tokens with `&#36;`; in your skill body, write a plain dollar sign.

| Token | Resolves to |
|-------|-------------|
| `&#36;ARGUMENTS` | full argument string as the user typed it |
| `&#36;ARGUMENTS[N]` or `&#36;N` | Nth positional, shell-quoted, 0-indexed |
| `&#36;<name>` | named argument from the `arguments:` frontmatter list |
| `&#36;{CLAUDE_SKILL_DIR}` | absolute path to this skill's directory |
| `&#36;{CLAUDE_SESSION_ID}` | current session id |
| `&#36;{CLAUDE_EFFORT}` | active effort level (`low`/`medium`/`high`/`xhigh`/`max`) |

Full table with examples and parsing pitfalls: `${CLAUDE_SKILL_DIR}/references/frontmatter.md`.

Set `argument-hint:` so autocomplete reflects the expected shape. If the body has no full-argument token and the user passed arguments, the loader appends `ARGUMENTS: <input>` automatically; treat that as a fallback, not a design.

## Pre-approving tools

Skip this section if the skill's tool calls already work without prompting in the user's normal permission flow. Most reference skills (no shell commands) and skills that only Read or Grep on already-permitted paths do not need `allowed-tools:` at all.

Set `allowed-tools:` only when the body issues specific tool calls that would otherwise prompt the user repeatedly during the run (a workflow that fires `gh pr view`, `git add`, `git commit` in sequence). It is friction reduction, not a security boundary. The user's deny rules still apply.

When you do set it, list narrow patterns matching the calls the body actually issues:

- Good: `Bash(gh pr view:*)`, `Bash(git add:*) Bash(git commit:*)`, `Read Grep Glob`
- Bad: `Bash` (whitelists every shell command, defeats the permission system), `*` (defeats the field entirely)

Read the body, enumerate every tool call it actually makes, list exactly those.

## Conditional activation

Skip `paths:` for most skills. The default (no `paths:`) means the skill is discoverable from session start, which is what you want when the skill applies broadly.

Set `paths:` only when the skill is genuinely relevant to a subset of files in a polyglot or monorepo setup (a `flutter-conventions` skill in a repo that also has a Rust backend; a `database-migrations` skill scoped to `db/migrations/**`). The glob list (gitignore syntax, comma string or YAML list) defers the skill from the description listing until the model touches a matching file, which keeps the description budget free for sessions that never need it.

## Bundled files

| Need | Put it in |
|------|-----------|
| Detailed reference docs the body points to | `references/<topic>.md` |
| Scripts the body runs via Bash | `scripts/<name>.<ext>` |
| Templates, fonts, icons used in output | `assets/<name>` |

Reference them explicitly from the body, anchored to a trigger (the block below uses HTML entity `&#36;` for `$` to avoid self-substitution; in your skill body, write the plain literal):

```markdown
For full schema details, read `&#36;{CLAUDE_SKILL_DIR}/references/api-schema.md`.
Run `python &#36;{CLAUDE_SKILL_DIR}/scripts/build_chart.py "&#36;ARGUMENTS"` to render the chart.
```

Relative paths break when the skill is invoked from a different cwd. `&#36;{CLAUDE_SKILL_DIR}` is the only portable form. For plugin skills, it is the only form that survives install.

## Workflow

Walk these in order. Each step assumes the previous resolved.

### 1. Capture intent

If the conversation already shows a workflow the user wants captured (corrections, tool sequence, edits to the format), extract from history. Otherwise ask in tight rounds via AskUserQuestion, not all at once.

Always-needed questions:

- What does the skill do, in one sentence?
- When should the model load it (trigger phrases, file types, user requests)?
- Project, user, or plugin scope?

Conditional questions (ask only when the answer to an always-needed question implies the skill needs the field):

- Inline or forked? Ask only if the work sounds bounded and self-contained (a research task, an audit). Default is inline for everything else.
- User-only vs both? Ask only if the skill has irreversible side effects (deploy, commit, send-message).
- Arguments? Ask only if the user implied the skill takes input.
- Pre-approved tools? Ask only if the skill chains specific tool calls in a way that would prompt the user repeatedly.

Resolve high-level shape first, fill in detail second. Do not pre-ask about every optional field; pull each in only when the conversation surfaces a reason.

### 2. Decide structure

Sketch the directory before writing files. If the body will reference `references/foo.md` or run `scripts/bar.py`, plan that now so the body and the bundled files stay consistent.

### 3. Write the frontmatter

Start with the minimal set and add fields only when the answers from step 1 forced a specific need:

```yaml
---
description: <Third-person summary of what the skill does + when to use it.>
when_to_use: <Optional: separate slot for trigger phrases if description is busy.>
---
```

That is the whole frontmatter for most reference skills and many simple workflow skills. The directory name supplies `name` by default; do not set `name` unless you need a different display name from the directory.

Add other fields only when a specific condition holds (see the "Frontmatter is minimal by default" table earlier in this file for the condition per field):

- `disable-model-invocation: true` for irreversible side effects.
- `argument-hint:` and `arguments:` when the skill takes input.
- `allowed-tools:` when the body chains tool calls that would prompt the user.
- `context: fork` (+ `agent:`) when the body is a bounded actionable task.
- `paths:` when the skill is path-conditional.
- `model:` / `effort:` / `hooks:` only when the skill genuinely needs them.

`description` + `when_to_use` is the trigger surface, the only thing the model sees before deciding to load the skill. Claude Code truncates the combined entry at 1,536 characters in the skill listing (see [Anthropic docs](https://docs.claude.com/en/docs/claude-code/skills.md)); anything past that is invisible to the trigger decision. Front-load the use case.

Triggering rules for the description text:

- **Third person.** "Summarizes a PR", not "I can summarize PRs" or "You can use this to summarize PRs". The description gets injected into the system prompt, mixed POV confuses skill discovery.
- **Front-load the verb and the noun.** Start with what the skill does, then the contexts that pull it in.
- **Be a little pushy.** Modern Claude undertriggers. Add: "Triggers on X, Y, Z. Use even when the user does not say 'skill' but asks for [common phrasing]."
- **Cover synonyms.** "Playbook", "checklist", "workflow", "procedure", "runbook" pull on different days.
- **Be specific.** "Use whenever PDFs are involved" loses; "Use when the user extracts form fields, fills PDF forms, or merges multi-page PDFs" wins.

For naming, prefer gerund (`processing-pdfs`, `analyzing-spreadsheets`). Avoid reserved words (`anthropic`, `claude`) and vague names (`helper`, `utils`, `tools`). Full field reference: `${CLAUDE_SKILL_DIR}/references/frontmatter.md`.

### 4. Write the body

The body is a prompt. Hand it off to the principles in the `ac:prompt-writer` skill:

- Persona / role at the top if the skill has a clear lens.
- Static rules and structure in stable order; the body is cached, dynamic content goes through the argument substitution tokens (see the Arguments section above).
- XML tags as delimiters when the skill processes documents or distinct content blocks.
- Numbered steps for multi-step workflows; sub-numbers (3a, 3b) for steps that run in parallel.
- A success criterion on every step. The model should know when to stop.
- End-of-prompt reminders for the top one or two constraints.

Skill-specific body conventions worth honoring:

- Lead with a one-paragraph **Overview** so the model knows the shape before reading steps.
- Keep SKILL.md under 500 lines (per [Anthropic guidance](https://docs.claude.com/en/docs/claude-code/skills.md)). Push detail into `references/` and anchor each from the body.
- For workflows: name the **Goal** (what done looks like), then **Steps**, each with a **Success criterion**.
- For reference content: name the **Scope** (what the rules apply to), then the rules.
- Include "ultrathink" anywhere in the body if the skill should enable extended thinking on invoke.

> **Footgun, shell-injection in the body.** Claude Code's preprocessor scans SKILL.md bytes for inline `` \!`<cmd>` `` and fenced ` ```\! ` blocks. Neither respects markdown fences. If you paste a literal `` \!`gh pr view` `` or a triple-backtick-plus-bang block as a documentation example (even inside a 4-backtick wrapper), Claude Code will execute it on every invocation. When DOCUMENTING shell-injection syntax, escape the bang as `\!`. The byte before `!` becomes `\`, which breaks the regex lookbehind (`(?<=^|\s)`) for the inline form and breaks the literal `\`\`\`!` start for the fenced form. When USING shell injection for real, plain `!` is correct, that is the live syntax.

For body content beyond surface guidance, invoke `/ac:prompt-writer` and then load its bundled references (its body lists them with anchored conditions). The architecture and snippets references in that skill carry the depth; do not duplicate that material here.

### 5. Bundle supporting files

If a step in the body would otherwise produce 200 lines of detail, push the detail into `references/<topic>.md` and have the body say "Read `&#36;{CLAUDE_SKILL_DIR}/references/<topic>.md` when [condition]." Anchor every reference to a trigger; without that, the model loads none of them or all of them.

If the body would otherwise tell the model to write the same script every invocation, write the script once into `scripts/` and orchestrate around it. Token savings compound across runs.

### 6. Verify

Before shipping:

1. **Frontmatter parses.** `description` is a string, `allowed-tools` matches the parser's expected shape (space-separated string or YAML list), no nonsense fields.
2. **Path references resolve.** Every `&#36;{CLAUDE_SKILL_DIR}/...` in the body points to a file that exists.
3. **Triggering reads cleanly.** Read `description` + `when_to_use` aloud, would the model load this skill on a relevant request? Combined under 1,536 characters?
4. **Body holds up cold.** Re-read as if you had never seen the conversation. Goal clear, steps actionable, success criteria present.
5. **Invoke it.** Run `/skill-name` in a fresh session. The first run surfaces every assumption.

Worked examples that pass all five gates: `${CLAUDE_SKILL_DIR}/references/examples.md`.

### 7. Iterate

If the skill misbehaves, route by symptom:

| Symptom | Fix |
|---------|-----|
| Does not trigger when it should | Strengthen `description`: more specific verbs, more trigger phrases, less vague |
| Triggers on unrelated work | Tighten `description`: remove broad keywords; add `disable-model-invocation: true` if it is user-only |
| Loads but does not change behavior | Strengthen the body: clearer goal, success criteria, lead with the rule; explain the why |
| Wastes turns on tangential exploration | Cut. Anything not pulling its weight; trust the model on the obvious |
| Repeats setup work every invocation | Bundle a script in `scripts/` and orchestrate around it |
| Stops influencing behavior mid-session | After auto-compact, only the first 5,000 tokens of each invoked skill survive. Move standing instructions to the top of the body. Re-invoke if needed. |

Deeper symptom-to-fix mapping: `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`.

## Sibling skills (route the surrounding shape)

This skill stays focused on the skill shape itself. The work around the skill routes through one of the following.

| Producing | Route shape through | Use this skill for |
|---|---|---|
| The prompt body inside any skill | `ac:prompt-writer` | The structural decisions around the body (this file) |
| A slash command (`/name [args]` with arguments, often manual-only) | `command-creator` (when available) | The skill-shape decisions; specialize through command-creator for arg design and shell injection |
| A subagent definition (`.claude/agents/<name>.md`) | `agent-creator` (when available) | The decision of whether to write a skill at all (vs an agent) |
| CLAUDE.md or `.claude/rules/<topic>.md` | `ac:claude-md-rules-creator` | The decision of whether to write a skill at all (vs a CLAUDE.md note) |
| Hook configuration (`settings.json`, lifecycle events) | `update-config` | The decision of whether to write a skill at all (vs a deterministic hook) |

When the user request implies any of the rows above, do both: invoke the matching creator for shape, then keep this skill loaded for what is still skill-shaped.

## Opus 4.8 and Sonnet 4.6 tuning

Default target is `claude-opus-4-8`. Sonnet 4.6 (`claude-sonnet-4-6`) and Haiku 4.5 (`claude-haiku-4-5-20251001`) follow the same shape at lower effort levels. Full per-knob detail: `${CLAUDE_SKILL_DIR}/references/opus-4-8-tuning.md`.

Quick deltas to keep in mind while authoring:

- **Literal interpretation.** Opus 4.8 will not generalize a rule across sections. State scope where a rule must span.
- **Verbosity self-calibrates.** Remove old "be concise" hedges; if you need length, ask positively.
- **Tool use is more conservative.** To increase tool calls, raise effort or describe when and how explicitly. Avoid "CRITICAL: ALWAYS use this tool" wording.
- **Subagent spawning is lower by default.** For fan-out, write: "Spawn multiple subagents in the same turn when fanning out across items. Do not spawn for work you can complete in a single response."
- **Effort overrides.** Use `effort:` frontmatter to set a higher level only for skills that need it (deep audits, multi-step migrations). Most skills inherit fine.

## Quick template

For the full annotated blank template (with every optional field commented inline and explained), read `${CLAUDE_SKILL_DIR}/assets/SKILL.template.md`. That asset is read raw via the Read tool, so the literal tokens survive intact in it and can be copied directly.

**Minimal form** (covers most skills, no optional fields):

```markdown
---
description: <Third-person summary of what the skill does + when to use it. Front-load the use case. Combined description + when_to_use under 1,536 chars.>
when_to_use: <Optional: separate slot for trigger phrases when description is busy.>
---

# <Skill Title>

<One-paragraph Overview.>

## Goal (workflow) or Scope (reference)
<What "done" looks like, or what the rules apply to.>

## Body
<Steps with success criteria, or rules with scope.>
```

That is enough for a reference skill (style guide, conventions) and many simple workflow skills. Stop here unless step 1's intent capture identified a specific need for an optional field.

**Expanded form** (only when needed; HTML entity `&#36;` for `$` to prevent self-substitution in this very SKILL.md; in your skill body, write a plain dollar sign):

```markdown
---
description: <as above>
when_to_use: <as above>
# Add only the fields that apply (see the "Frontmatter is minimal by default" table earlier):
# argument-hint: "<[arg1] [arg2]>"
# arguments: [arg1, arg2]
# disable-model-invocation: true   # user-only; irreversible side effects
# user-invocable: false             # model-only; background reference knowledge
# allowed-tools: Bash(gh pr view:*) Read Grep   # narrow patterns; never bare Bash
# context: fork                     # subagent execution; body must be an actionable task
# agent: Explore                    # subagent type when forked
# paths: ["lib/**/*.dart", "pubspec.yaml"]   # auto-activate only when matching files are touched
# model: claude-opus-4-8            # override the active model for this skill's run
# effort: high                      # override the active effort level
# hooks: ...                        # skill-scoped hook enforcement
---

# <Skill Title>

<One-paragraph Overview: what the skill does, when it fires, what it leaves behind.>

## Goal
<What "done" looks like. Observable. For reference skills, replace with "Scope".>

## Workflow
<Optional inline checklist for skills with 5+ steps.>

### 1. <Step name>
<What to do. Be specific. Commands and file paths when low-freedom; principles when high-freedom.>

**Success criterion**: <how the model knows this step is done>

### 2. <Step name>
<...>

## Rules
<Standing instructions that apply throughout. For reference skills, this is the body.>

## When you need details
- For <topic>, read `&#36;{CLAUDE_SKILL_DIR}/references/<file>.md`.

## Bundled scripts
- `&#36;{CLAUDE_SKILL_DIR}/scripts/<name>.<ext>`, <what it does, args, output location>
```

In your real skill body, drop the HTML entity and write a plain dollar sign. The `assets/SKILL.template.md` asset shows the literal form ready to copy.

## Pre-flight checklist

Before declaring the skill done:

Always check:

- [ ] Directory at the right scope (managed / user / project / plugin).
- [ ] Directory name = skill slug (lowercase, hyphens, max 64 characters, no `claude` or `anthropic`).
- [ ] Frontmatter has `description`; `name` set only if it differs from the directory; `when_to_use` set if trigger phrases need their own slot.
- [ ] Combined `description` + `when_to_use` under 1,536 characters, front-loaded with the use case.
- [ ] Pushy phrasing covers common synonyms and adjacent wordings.
- [ ] No optional fields set that the skill does not actually need (cargo-culting hurts).

Check only the items that apply to your skill's specific needs:

- [ ] (If `disable-model-invocation: true` is set) the skill has irreversible side effects that justify user-only invocation.
- [ ] (If `user-invocable: false` is set) the skill is background context with no meaningful slash-menu use.
- [ ] (If `context: fork` is set) the body is a bounded actionable task, not reference content.
- [ ] (If `allowed-tools:` is set) it lists narrow patterns the body actually calls, never bare `Bash`.
- [ ] (If `paths:` is set) the skill is genuinely path-conditional and the description budget benefits from deferred loading.
- [ ] Body under 500 lines; detail in one-level-deep `references/` files with anchored "read this when X" pointers.
- [ ] Reference files over 100 lines start with a `## Contents` table of contents so partial reads do not miss the scope.
- [ ] Body uses the skill-directory token for every bundled-file reference (plugin-portable). In your skill body, write a plain dollar sign followed by `{CLAUDE_SKILL_DIR}`.
- [ ] Every step has a success criterion; reference content has scope.
- [ ] Body passes the `ac:prompt-writer` audit: no aggressive caps, no negative-only instructions, no "based on your findings" in forked skills, positive instructions, why explained when non-obvious.
- [ ] Effort and model overrides match task complexity.
- [ ] Test invocation in a fresh session passes.

## References

| File | Load when... |
|---|---|
| `${CLAUDE_SKILL_DIR}/references/frontmatter.md` | Designing or auditing frontmatter: every field, valid values, examples, parsing pitfalls. |
| `${CLAUDE_SKILL_DIR}/references/patterns.md` | Choosing between reference and task content, inline vs fork, when to bundle scripts, progressive disclosure, conditional activation, hooks. |
| `${CLAUDE_SKILL_DIR}/references/claude-code-mechanics.md` | Understanding runtime lifecycle (load, invocation, auto-compact, char budget), substitutions, shell injection, location precedence. |
| `${CLAUDE_SKILL_DIR}/references/examples.md` | Copying from a worked example: reference, manual-action, forked, scripted, path-conditional, plugin-distributed. |
| `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` | Diagnosing a misbehaving skill or auditing one before shipping. |
| `${CLAUDE_SKILL_DIR}/references/opus-4-8-tuning.md` | Tuning effort, verbosity, tool use, subagent spawning, thinking, model overrides; Sonnet 4.6 and Haiku 4.5 deltas. |
| `${CLAUDE_SKILL_DIR}/assets/SKILL.template.md` | Starting a new skill from a blank annotated template. |

For the prompt body itself, invoke `/ac:prompt-writer` and follow the references it lists from its own body:

- The high-level shape and the 7-component message architecture.
- Snippets for copy-paste building blocks (verbosity, parallel tool use, hallucination control, output format).
- Anti-patterns for what not to do.
- Opus 4.8 tuning for effort, thinking, and tool-use deltas.

Sibling-skill files cannot be read by path from here, since the install layout is unknown at author time. Invocation is the portable form.

Canonical Anthropic documentation, served as raw markdown by appending `.md` to the URL:

- Skills feature and frontmatter reference: `https://docs.claude.com/en/docs/claude-code/skills.md`
- Subagents and `skills:` preload: `https://docs.claude.com/en/docs/claude-code/sub-agents.md`
- Slash commands: `https://docs.claude.com/en/docs/claude-code/slash-commands.md`
- Hooks: `https://docs.claude.com/en/docs/claude-code/hooks.md`
- Plugins: `https://docs.claude.com/en/docs/claude-code/plugins.md`
- Agent Skills open standard: `https://agentskills.io/specification`

When canonical docs conflict with observed CLI behavior, trust the live binary.
