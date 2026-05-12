# Skill Patterns

Design patterns for Claude Code skills: which shape fits which task, how the pieces fit, what the body should look like for each kind. Read this when deciding the structural shape before writing the body.

## Contents

- Degrees of freedom
- Reference content vs task content
- Hybrid skills
- Inline vs forked
- When to bundle a script
- Progressive disclosure
- Domain organization (multi-domain skills)
- Conditional activation with `paths:`
- Pre-approving tools
- Hooks scoped to a skill
- Argument design
- Skill content lifecycle
- Workflow checklist pattern
- Feedback loop pattern
- Plan-validate-execute pattern
- When a skill is the wrong tool

## Degrees of freedom

Match how strictly the body constrains the model to the task's fragility. Three settings:

| Setting | Body shape | Use when |
|---------|------------|----------|
| **High freedom** | Text instructions, principles, heuristics | Multiple approaches valid; decisions depend on context (code review, exploration, design) |
| **Medium freedom** | Pseudocode, parameterized scripts, templates with options | A preferred pattern exists; some variation acceptable (report generation, scaffolding) |
| **Low freedom** | Specific scripts, exact commands, fixed sequences | Operations are fragile; consistency is critical (migrations, deploys, irreversible actions) |

Picture the model as walking a path. Open field, no hazards, many routes lead to success, give general direction and trust the model (high freedom). Narrow bridge, cliffs on both sides, one safe way through, specific guardrails and exact instructions (low freedom).

The most common authoring mistake is over-constraining open-field tasks (verbose instructions on something the model already knows) or under-constraining narrow-bridge tasks (vague guidance on something fragile). Pick the setting that matches, then write to it.

## Reference content vs task content

Two body shapes cover most skills. Pick by asking what you want the model to do with the body when it loads.

### Reference content

Knowledge the model applies alongside the conversation: conventions, style guides, domain facts, naming rules. The body sets a lens; no specific action is required.

```markdown
---
name: laravel-conventions
description: Applies Laravel coding conventions for this codebase. Triggers on PHP work in `app/`, `tests/`, or `database/migrations/`, on words like "controller", "service", "form request", "migration", and on requests to add or refactor backend features. Use even when the user does not say "Laravel" but is asking about server-side PHP.
paths:
  - "app/**/*.php"
  - "tests/**/*.php"
  - "database/migrations/*.php"
---

# Laravel Conventions

Apply these to every PHP file you create or modify in this repo.

## Naming
- PascalCase for classes, camelCase for methods, snake_case for table columns.
- Service classes end with `Service`. Form Requests end with `Request`. Resources end with `Resource`.

## Architecture
- Thin controllers, fat services. Constructor injection only, no facades inside classes.
- Enums for all status/type/category values. Place under `App\Enums`.

## Tests
- Pest for new tests. PHPUnit-style only when extending existing test files.
- Every Service public method gets a feature test that hits the route, not the method directly.
```

Reference skills are usually inline (no `context: fork`), often have `paths:` to scope activation, rarely take arguments.

### Task content

Step-by-step procedure for a specific action. The body has a goal, ordered steps, and success criteria.

```markdown
---
name: cherry-pick-to-release
description: Cherry-picks a merged PR to the current release branch. Use when the user says "cherry-pick to release", "CP this PR", "backport this", "hotfix this PR".
disable-model-invocation: true
argument-hint: "[pr-number]"
arguments: [pr_number]
allowed-tools: Bash(gh:*) Bash(git:*)
---

# Cherry-pick PR $pr_number to release branch

## Goal
Get PR $pr_number's commits onto the current release branch with CI passing, then open a backport PR.

## Steps

### 1. Identify the merge commit
Run `gh pr view $pr_number --json mergeCommit -q .mergeCommit.oid` to capture the merge SHA.
**Success criterion**: a 40-character SHA on stdout. If empty, the PR is not merged, stop and tell the user.

### 2. Fetch the latest release branch
`git fetch origin release && git checkout release && git pull --ff-only`.
**Success criterion**: HEAD on `origin/release`, working tree clean.

### 3. Create the backport branch
`git checkout -b cp/$pr_number`.

### 4. Cherry-pick
`git cherry-pick <merge-sha>`. On conflicts, stop and ask the user how to resolve.
**Success criterion**: clean cherry-pick or user-confirmed resolution.

### 5. Push and open PR
`git push -u origin cp/$pr_number` then `gh pr create --base release --title "Cherry-pick #$pr_number" --body "Backports #$pr_number to release."`.
**Success criterion**: PR URL printed.
```

Task skills usually take arguments, often have `disable-model-invocation: true` (the user knows when to fire them), often run forked (`context: fork`) for self-contained work.

## Hybrid skills

Some skills are reference plus a workflow: a section of conventions and a few common procedures. That works; keep the workflow part separate from the reference part inside the body so the model knows which is which.

## Inline vs forked

| Decision | Inline (default) | Forked (`context: fork`) |
|----------|------------------|--------------------------|
| Conversation history | Available | Not available |
| User can steer mid-process | Yes | No |
| Body is an actionable prompt | Optional | Required |
| Cleanup of main context | No | Yes |
| `agent:` field | Ignored | Picks subagent type |

Pick fork when the work is bounded (research, build, audit), the body has a clear actionable goal, and you do not want the work polluting the main conversation.

Pick inline when the user might want to interject ("actually, do it like this"), the work depends on what was just discussed, or the body is reference material.

## When to bundle a script

Skills can ship scripts in `scripts/`. The body invokes them via Bash:

```markdown
Generate the report by running the bundled script:

`!`python ${CLAUDE_SKILL_DIR}/scripts/build_report.py "$ARGUMENTS"``

Then read the output at `report.html` and summarize what changed.
```

Bundle a script when:

- The work would otherwise be the same logic in every invocation (parsing, file generation, fixed transforms).
- Determinism matters more than flexibility.
- The output is a file the model would not produce directly (HTML, .docx, .xlsx, images).

Do not bundle when:

- The logic is one tool call (`Bash(git status)`).
- The work needs the model's reasoning (the script removes the model's contribution).
- Maintenance cost outweighs invocation savings.

The script's interface should be stable: name, args, exit code, output location. The body should commit to that interface.

## Progressive disclosure

The model loads the body when the skill triggers, but `references/` and `scripts/` only load on demand. Use this:

```markdown
Read these references when you need them:
- `${CLAUDE_SKILL_DIR}/references/api-schema.md`, full request/response shapes
- `${CLAUDE_SKILL_DIR}/references/error-codes.md`, every error code and meaning
- `${CLAUDE_SKILL_DIR}/references/migration-guide.md`, how to migrate from v1 to v2
```

Anchor each reference to its trigger ("when the user asks about errors, read error-codes.md"). Without that, the model may load none of them or all of them.

**Keep references one level deep.** SKILL.md to reference file is fine; reference file to another reference file is not. The model often previews referenced files with `head -100` or partial reads when they are nested through a chain, so important content past the preview window can be missed. Every reference file should link directly from SKILL.md.

**Add a TOC for files over 100 lines.** When the model partial-reads, the TOC guarantees it sees the full scope of what the file contains:

```markdown
# API Reference

## Contents
- Authentication and setup
- Core methods (create, read, update, delete)
- Advanced features (batch operations, webhooks)
- Error handling patterns
- Code examples

## Authentication and setup
...
```

## Domain organization (multi-domain skills)

When a skill covers multiple domains (cloud providers, frameworks, languages), split into per-domain references and let the body route:

```
cloud-deploy/
├── SKILL.md          # workflow + selection logic
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

```markdown
## Step 1: Select provider
Identify the target provider from the user's request or `cloud.config.yaml`.

Then load the matching reference:
- AWS, read `${CLAUDE_SKILL_DIR}/references/aws.md`
- GCP, read `${CLAUDE_SKILL_DIR}/references/gcp.md`
- Azure, read `${CLAUDE_SKILL_DIR}/references/azure.md`
```

The model only loads the file it needs. Other domains stay on disk.

## Conditional activation with `paths:`

Path-conditional skills are stored when the session starts but only activated when the model touches a matching file. They are invisible to the trigger decision until then.

Use `paths:` when:

- The skill is relevant only to a subset of files (a `flutter-conventions` skill in a polyglot monorepo).
- You want to avoid bloating the description budget for sessions that never need this skill.

Avoid `paths:` when:

- The skill should be discoverable via `/name` immediately.
- The user might invoke it before any relevant file is touched.

Matching syntax is gitignore-style, same as path-specific rules in CLAUDE.md. The loader drops `/**` suffixes so `lib/**` and `lib/**/*` match the same set.

## Pre-approving tools

`allowed-tools:` is friction reduction, not a security boundary. The user still has the permission system; this just keeps the skill from prompting on every tool call while it runs.

Patterns:

- **Glob commands narrowly**: `Bash(gh pr view:*)`, not `Bash(gh:*)` if you only call `gh pr view`.
- **List the actual calls**: read the body, list every tool the steps invoke, put exactly those in the field.
- **Avoid `Bash` alone**: that pre-approves every shell command, defeating the purpose.

For skills the user invokes manually, narrower is better. For skills the model auto-loads, even narrower, the model might surprise you with a tool you forgot to think about, and you want that surprise to surface as a permission prompt rather than a silent execution.

## Hooks scoped to a skill

Frontmatter `hooks:` fires only while the skill is active. Same shape as project hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, etc.), same handler types (command, agent, message).

Use skill-scoped hooks for:

- Logging tool calls during an `/audit` skill.
- Gating destructive commands during a `/deploy` skill.
- Validating output during a `/release-notes` skill.

Do not use hooks for behavior the body can express directly. Hooks are deterministic enforcement; body instructions are negotiable. Reach for hooks only when negotiation is not enough.

## Argument design

If the skill takes input, design the argument shape before writing the body.

- **One free-form arg** (`$ARGUMENTS`) for skills that take a sentence or query: `/deep-research how does auth work in this monorepo`.
- **Named positional args** for skills with structured input: `/migrate-component SearchBar React Vue` with `arguments: [component, from, to]`.
- **No args** for skills that read state from the environment (the current branch, the current file, recent diff).

Document the expected shape in `argument-hint:` so autocomplete reflects what the skill expects. If the body uses `$ARGUMENTS[0]` etc., document each position in the body so the model knows what it received.

## Skill content lifecycle

The body enters the conversation as a single message when invoked and stays for the rest of the session. Claude does not re-read the file on later turns. Auto-compact carries invoked skills forward (first 5,000 tokens of each, 25,000-token shared budget, most recent first).

This shapes the body:

- **Standing instructions, not one-time steps.** "Always use the bundled script" lasts; "for this session, use the bundled script" rots.
- **Top 5,000 tokens are the ones that survive compact.** Put load-bearing rules near the top.
- **Re-invoke after compact** if the skill drops out and behavior shifts. Or strengthen the description so the model invokes again on its own.
- **Hooks are deterministic where instructions are not.** If the skill must enforce something (no force-push, every tool call logged), put it in `hooks:`, not the body.

## Workflow checklist pattern

For complex multi-step tasks, give the model an inline checklist to copy into its response and tick off as it progresses. This works for code-driven workflows and pure-analysis workflows alike.

```markdown
## Form filling workflow

Copy this checklist and check off items as you complete them:

```
Task progress:
- [ ] Step 1: Analyze the form (run analyze_form.py)
- [ ] Step 2: Create field mapping (edit fields.json)
- [ ] Step 3: Validate mapping (run validate_fields.py)
- [ ] Step 4: Fill the form (run fill_form.py)
- [ ] Step 5: Verify output (run verify_output.py)
```

**Step 1: Analyze the form**

Run: `python scripts/analyze_form.py input.pdf`

This extracts form fields and their locations, saving to `fields.json`.

[... and so on for each step]
```

The checklist anchors progress, prevents step-skipping, and gives both the model and the user a shared map of where the work is. Use for any workflow with five or more steps where the order matters.

## Feedback loop pattern

For quality-critical work, build a validator into the workflow and loop on errors:

```markdown
## Document editing process

1. Make edits to `word/document.xml`.
2. Validate immediately: `python ooxml/scripts/validate.py unpacked_dir/`
3. If validation fails:
   - Read the error message carefully
   - Fix the issues in the XML
   - Run validation again
4. Only proceed when validation passes.
5. Rebuild: `python ooxml/scripts/pack.py unpacked_dir/ output.docx`
6. Test the output document.
```

For pure-prose work, the "validator" can be a style guide reference file: draft, review against the checklist in STYLE_GUIDE.md, fix issues, re-check, finalize. The pattern is the same, an explicit verification gate and a loop on failure.

This catches errors before they compound and gives the model a clear stopping condition.

## Plan-validate-execute pattern

For batch operations or destructive changes (updating 50 PDF form fields, applying a structured change to many files), have the model first write a plan as a structured artifact, validate the plan with a script, then execute. The workflow becomes:

```
1. Analyze inputs
2. Write a plan file (e.g., changes.json)
3. Validate the plan with a script
4. Execute the validated plan
5. Verify output
```

Why this works:

- **Catches errors early.** Validation finds problems before the destructive step.
- **Machine-verifiable.** The script gives an objective gate.
- **Reversible planning.** The model can iterate on the plan without touching originals.
- **Clear debugging.** Validation errors point to specific issues.

Use for high-stakes operations where "the model rolls forward and we hope" is too risky.

## When a skill is the wrong tool

Sometimes the answer is not a skill.

- **Single fact, never changes** to CLAUDE.md, route through `ac:claude-md-rules-creator`.
- **One-off task** to just do it.
- **Very long always-on context** to CLAUDE.md if it must always be loaded, skill with `paths:` if conditional, refactor into the codebase if it is documentation rotting in chat.
- **Determinism the body cannot guarantee** to a hook, not a skill, route through `update-config`.
- **Cross-cutting agent persona** to a custom agent in `.claude/agents/`, possibly with the skill preloaded via the agent's `skills:` field. Route through `agent-creator`.
