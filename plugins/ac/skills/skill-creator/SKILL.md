---
name: skill-creator
description: "Create or audit a Claude Code skill or slash workflow: frontmatter, arguments, invocation, and bundled files."
when_to_use: "Use when writing, editing or debugging a skill or a /command, or turning a procedure you keep retyping into one."
disable-model-invocation: false
---

# Skill Creator

You are about to write or edit a skill another Claude will load. A skill is a directory with a `SKILL.md`: the frontmatter decides whether and how it loads, the body is a prompt that enters the conversation when it fires and stays for the rest of the session. User-typed slash workflows (`/deploy`, `/commit`) are skills too; custom commands were merged into skills, so this skill covers both. Checked against Claude Code 2.1.314 on 2026-10-31.

The body of every skill you produce is a prompt: route that work through `ac:prompt-writer` instead of restating prompt principles here. This file owns the shape: scope, frontmatter, invocation, layout, bundling.

## Rules that hold for every skill

1. **Concise is the contract.** The body shares the context window with everything else. Add only what Claude would not know without you, and test each paragraph against "does this justify its tokens?"
2. **The listing decides.** The model picks a skill from `description` plus `when_to_use` alone. Imperative verb and object, one "Use when" sentence, about 200 characters combined, no mechanics.
3. **Minimal frontmatter.** `description` and `when_to_use` cover most skills. Add any other field only when you can name the condition that needs it.
4. **Rules first, depth in references.** After compaction only the first 5,000 tokens of an invoked skill are kept, so standing rules go at the top and detail moves to one-level-deep `references/` files, each anchored with "read this when X".
5. **Standing instructions.** The body is read once and stays. Write rules that hold for the session, not "for this turn".
6. **Scope in both directions.** Say where a rule spans and what the skill does not touch; current models widen scope on their own.
7. **Plain wording.** No "CRITICAL" or "you MUST"; state the rule once with its reason.
8. **Portable paths.** Bundled files are referenced through the skill-directory token, never a repo-relative path.

## Decision flow

```
Is a skill the right tool?
├── A fact that never changes → CLAUDE.md or a rule, via `ac:claude-md-rules-creator`.
├── A why-and-scope or architecture document → `ac:project-md-writer` or `ac:design-md-writer`.
├── Must happen deterministically → a hook, via `update-config`.
├── Needs its own context, tools or model → a subagent, via `ac:agent-creator`.
├── A one-off task → just do it.
└── A recurring procedure, playbook or body of knowledge → a skill. Continue.

Does the user type it as `/name [args]`, does it take arguments, gather live state, or have side effects?
├── YES → this file for shape, plus `${CLAUDE_SKILL_DIR}/references/user-typed-skills.md`
│         (arguments, shell injection, phases, approval gates, commands as the older format).
└── NO  → this file alone.

Auditing or fixing an existing skill?
├── YES → `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`, then `claude-code-mechanics.md` if behaviour is unclear.
└── NO  → walk the Workflow below.
```

When the path runs through a sibling creator, invoke it for its shape and keep this skill loaded for what is still skill-shaped.

## Where skills live

| Scope | Path | Reach |
|-------|------|-------|
| Managed | enterprise managed directory | Everyone in the org; highest precedence |
| User | `~/.claude/skills/<name>/SKILL.md` | Every project on this machine |
| Project | `.claude/skills/<name>/SKILL.md` (walks up from cwd) | This repo; commit to share |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Wherever the plugin is installed, as `<plugin>:<name>` |

Precedence is managed > user > project; plugin skills sit in their own namespace. A legacy `.claude/commands/<name>.md` still creates `/name`, and a skill of the same name wins over it. Prefer a skill for new work.

## Frontmatter

> **Escape convention.** This SKILL.md is preprocessed on every invocation, so a token written with a plain dollar sign would be substituted and corrupt the docs. Tokens that are named rather than used appear with `&#36;` for the dollar sign (`&#36;ARGUMENTS`); in your own skill, write a plain `$`. Shell-injection examples appear as `\!`; write a plain `!` when you mean to run it.

Every field is optional; unknown fields are ignored. Frontmatter is read only when `---` is line 1. Booleans accept `true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`.

| Field | Default | Semantics, and when to set it |
|-------|---------|-------------------------------|
| `name` | directory name | Display name and slash name; lowercase, digits, hyphens, at most 64 characters; the `anthropic-skills` namespace is reserved. Optional when it equals the directory name |
| `description` | first body paragraph | What it does; the trigger surface. Always set |
| `when_to_use` | none | One "Use when" sentence, appended to `description` in the listing |
| `argument-hint` | none | Autocomplete text after `/name`; never reaches the model |
| `arguments` | none | Named positionals for `&#36;name` substitution; the first 64 names of up to 64 characters are filled (2.1.301) |
| `disable-model-invocation` | `false` | `true`: only the user can run it, its description leaves the model's listing, and it cannot be preloaded into a subagent. For side effects |
| `user-invocable` | `true` | `false`: hidden from the `/` menu, the model can still load it. For background knowledge |
| `allowed-tools` | none | Pre-approves matching tool calls for the invoking turn only; never restricts. Narrow patterns |
| `disallowed-tools` | none | Removes tools while the skill is active; cleared on the next message (2.1.152) |
| `context` | inline | `fork` runs the body as a task in a subagent without the conversation history |
| `agent` | `general-purpose` | Subagent type for `context: fork`; an unknown name falls back to `general-purpose` |
| `background` | `true` (2.1.218) | Fork only: whether the forked run goes to the background |
| `paths` | none | Globs (gitignore syntax); the skill is listed only once a matching file is touched |
| `model` | session model | Model for the invoking turn; `inherit` allowed |
| `effort` | session effort | `low`, `medium`, `high`, `xhigh`, `max`; holds for the rest of the turn |
| `hooks` | none | Registered when the skill is invoked and kept for the rest of the session (`once: true` on a hook removes it after its first run); at most 1,024 hooks and 16,384 matcher characters per source per session (2.1.304) |
| `shell` | `bash` | `bash` or `powershell`, for shell-injection blocks |
| `metadata`, `license`, `compatibility` | none | Agent Skills spec fields; accepted, not acted on. `compatibility` is capped at 500 characters |

Substitutions in the body: `&#36;ARGUMENTS`, `&#36;N`, `&#36;ARGUMENTS[N]`, `&#36;name`, `&#36;{CLAUDE_SKILL_DIR}`, `&#36;{CLAUDE_SESSION_ID}`, `&#36;{CLAUDE_EFFORT}`, and in fork skills `&#36;{CLAUDE_PROJECT_DIR}` and `&#36;{CLAUDE_PLUGIN_DATA}`; plugin skills also get `&#36;{CLAUDE_PLUGIN_ROOT}`. Per-field detail, examples and parsing pitfalls: `${CLAUDE_SKILL_DIR}/references/frontmatter.md`.

Copying every field from a template "just in case" is the most common frontmatter mistake: each unused field is noise, and a stale one (a `paths:` that no longer matches, an `allowed-tools` that drifted from the body) hides bugs.

## Invocation and execution

| Frontmatter | User types `/name` | Model loads it | Use for |
|-------------|--------------------|----------------|---------|
| defaults | yes | yes | most skills |
| `disable-model-invocation: true` | yes | no | irreversible side effects: deploy, commit, send |
| `user-invocable: false` | no | yes | background knowledge nobody would type |

A `disable-model-invocation` skill is reachable only by a user typing it, so never write "run `/name`" for the model in a plan or another skill; write "ask the user to run it".

Inline is the default and fits most skills: the body sees the conversation and the user can steer. Set `context: fork` only when the body is a bounded, actionable task that needs no steering; reference content in a fork gives a subagent guidelines and no goal. A fork has no AskUserQuestion, so a skill with approval gates stays inline. Pick `agent:` for the fork (`ac:explore` for read-only investigation, or a custom agent); built-in `Explore` and `Plan` are disabled on an `/ac:install` setup.

`allowed-tools` is friction reduction, not a boundary: list exactly the calls the body makes (`Bash(gh pr view:*)`, `Read Grep`), never bare `Bash`. To take tools away for the skill's turn, use `disallowed-tools`.

Leave `paths:` off unless the skill only matters for some files of a polyglot repo; it keeps the description out of sessions that never touch them.

## Listing and compaction

- Every skill name is always listed. Descriptions share a budget of 1% of the context window (`skillListingBudgetFraction`); on overflow the least-invoked lose their description first.
- `description` plus `when_to_use` is capped at 1,536 characters per entry (`skillListingMaxDescChars`). Aim for about 200; the cap is not a target.
- After compaction each invoked skill keeps its first 5,000 tokens, within a 25,000-token budget shared by all invoked skills.
- `/reload-skills` sends only the skills that changed (2.1.304); `/skill-doctor` audits the installed skills.

Detail on load order, overrides and budgets: `${CLAUDE_SKILL_DIR}/references/claude-code-mechanics.md`.

## Bundled files

| Need | Put it in |
|------|-----------|
| Detail the body points to | `references/<topic>.md` |
| Code the body runs | `scripts/<name>.<ext>` |
| Templates and other output material | `assets/<name>` |

Reference each from the body with the condition that loads it: "Read `&#36;{CLAUDE_SKILL_DIR}/references/api-schema.md` when the request touches the API." Relative paths break when the cwd differs, and for plugin skills the token is the only form that survives install. The token is the skill's own directory, not the plugin root. Reference files are read raw, so live syntax in them is safe; a reference over 100 lines opens with a `## Contents` list.

## Workflow

### 1. Capture intent

Extract from the conversation when it already shows the procedure (corrections, tool sequence, format edits); otherwise ask in short AskUserQuestion rounds. Always ask what it does, what situation loads it, and the scope. Ask about forking, user-only invocation, arguments or pre-approved tools only when an answer implies the field.

**Success criterion**: you can state the skill in one sentence and name each optional field it needs, with the reason.

### 2. Sketch the directory

Plan `references/`, `scripts/` and `assets/` before writing, so the body and its files agree.

### 3. Write the frontmatter

```yaml
---
description: <Imperative verb + object, one sentence, 60 to 120 characters.>
when_to_use: <One "Use when..." sentence, under 150 characters.>
---
```

Then add only the fields step 1 justified. Write the trigger surface the way Claude Code's bundled skills do:

- Open with the verb and its object: "Create a git commit."
- One "Use when" sentence naming the situation, not a list of phrasings.
- At most one boundary clause, with a redirect.
- No stages, file paths or agent names. Name a flag only when the model must pass it, because `argument-hint` never reaches the model.
- A skill that does not fire gets a more exact situation, not more synonyms or caps; a trigger that must never be lost goes in CLAUDE.md.

Prefer gerund or noun-phrase names (`processing-pdfs`); avoid vague ones (`helper`, `utils`).

### 4. Write the body

Invoke `ac:prompt-writer` for the prompt itself. Skill-specific conventions: a one-paragraph overview first; a Goal with Steps and a success criterion each for workflows, a Scope and rules for reference content; under 500 lines, with detail moved out to references rather than compressed into longer lines, because the 5,000-token compaction window is measured in tokens. User-typed workflows add argument design, shell-injected context, phases and approval gates: `${CLAUDE_SKILL_DIR}/references/user-typed-skills.md`.

The shell-injection preprocessor scans raw bytes and ignores markdown fences: a documentation example written as `` \!`gh pr view` `` with a plain bang runs on every invocation. Escape the bang when documenting; use a plain `!` only when you mean it.

### 5. Bundle

A step that would add 200 lines of detail becomes a reference with an anchored pointer. A script the model would rewrite every run becomes a file in `scripts/`.

### 6. Verify

1. Frontmatter parses: `---` on line 1, quoted strings where they contain colons, no invented fields.
2. Every `&#36;{CLAUDE_SKILL_DIR}/...` path in the body exists.
3. The trigger surface reads cleanly: it would load on a relevant request and stay out of a neighbouring one.
4. The body holds up for a reader who has never seen the conversation.
5. A fresh-session invocation behaves as intended; for a typed workflow, run `/name` with typical arguments.

Worked examples: `${CLAUDE_SKILL_DIR}/references/examples.md`.

### 7. Iterate

| Symptom | Fix |
|---------|-----|
| Does not trigger | Name the situation more exactly in `when_to_use`; name the skill in CLAUDE.md if it must never be missed |
| Triggers on unrelated work | Remove broad words from `description`; set `disable-model-invocation: true` if it is user-only |
| Loads but changes nothing | Lead with the rule, state the goal and success criteria, give the why |
| Stops influencing mid-session | Move standing rules into the first 5,000 tokens; re-invoke after compaction |
| Repeats setup every run | Bundle a script |
| Literal `&#36;ARGUMENTS` or an unexpected command in the rendered prompt | See `user-typed-skills.md` on substitution and the injection escape |

Deeper mapping: `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`.

## Model notes

A skill body runs on the session model, which for this plugin is usually Opus 5.5 or Sonnet 5.5. Both land on Claude Code's lean prompt, which lacks the classic code-style rules, so a skill that needs one states it. Set `effort:` only when the skill's work needs a different level from the session's; it holds for the rest of the turn, and Haiku 4.5 (the `haiku` target on Bedrock, Vertex, Foundry and Claude Platform on AWS) takes no effort value at all. Per-model tuning lives in `ac:prompt-writer`.

## Sibling skills

| Producing | Route shape through | Use this skill for |
|---|---|---|
| The prompt body inside any skill | `ac:prompt-writer` | The structure around the body |
| A subagent definition | `ac:agent-creator` | Whether to write a skill at all, or a `context: fork` skill instead |
| CLAUDE.md or `.claude/rules/<topic>.md` | `ac:claude-md-rules-creator` | Whether the content is a procedure (skill) or a standing fact |
| PROJECT.md or DESIGN.md | `ac:project-md-writer`, `ac:design-md-writer` | Whether a procedure belongs in a skill or a fact in a design document |
| Hook configuration | `update-config` | Whether the behaviour needs determinism (hook) or judgment (skill) |

## Pre-flight checklist

- [ ] Right scope; directory name is the slug.
- [ ] `description` opens with a verb; `when_to_use` is one "Use when" sentence; about 200 characters combined; no mechanics.
- [ ] Every optional field present has a named reason; none copied from a template.
- [ ] (`disable-model-invocation: true`) the skill has side effects, and nothing tells the model to run it.
- [ ] (`context: fork`) the body is a bounded actionable task with no approval gates.
- [ ] (`allowed-tools`) narrow patterns matching the calls the body makes.
- [ ] (`paths`) the skill is genuinely path-conditional.
- [ ] (Typed workflow) the `user-typed-skills.md` pre-flight additions pass.
- [ ] Body under 500 lines, standing rules in the first 5,000 tokens, bundled files referenced through the skill-directory token.
- [ ] Body passes the `ac:prompt-writer` audit.
- [ ] A fresh-session invocation passes.

## References

| File | Load when... |
|---|---|
| `${CLAUDE_SKILL_DIR}/references/frontmatter.md` | Designing or auditing frontmatter: every field, values, examples, parsing pitfalls. |
| `${CLAUDE_SKILL_DIR}/references/user-typed-skills.md` | A `/name [args]` workflow: argument design, shell-injected context, phases, approval gates, side-effect invocation control, commands as the older format. |
| `${CLAUDE_SKILL_DIR}/references/patterns.md` | Choosing reference vs task content, inline vs fork, scripts, progressive disclosure, conditional activation, hooks. |
| `${CLAUDE_SKILL_DIR}/references/claude-code-mechanics.md` | Runtime lifecycle: discovery, listing budget, compaction, substitutions, permissions, precedence. |
| `${CLAUDE_SKILL_DIR}/references/examples.md` | Copying from a worked example: reference, manual-action, forked, scripted, path-conditional, plugin-distributed. |
| `${CLAUDE_SKILL_DIR}/references/anti-patterns.md` | Diagnosing a misbehaving skill or auditing one before shipping. |
| `${CLAUDE_SKILL_DIR}/references/opus-5-tuning.md` | Effort, verbosity and model overrides for a skill, per model. |
| `${CLAUDE_SKILL_DIR}/assets/SKILL.template.md` | Starting from a blank annotated template. |

Sibling skills are reached by invocation (`/ac:prompt-writer`), not by path, because the install layout is unknown at author time.

Canonical documentation (append `.md` for raw markdown): skills `https://code.claude.com/docs/en/skills.md`, subagents `https://code.claude.com/docs/en/sub-agents.md`, hooks `https://code.claude.com/docs/en/hooks.md`, plugins `https://code.claude.com/docs/en/plugins-reference.md`, Agent Skills standard `https://agentskills.io/specification`. When the docs and the live binary disagree, trust the binary.
