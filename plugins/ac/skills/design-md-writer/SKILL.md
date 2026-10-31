---
name: design-md-writer
description: "Write or audit a DESIGN.md (architecture, data flow, invariants, decisions) for agents; also covers UI token specs."
when_to_use: "Use when creating or updating a design doc, or when agent changes keep landing in the wrong place."
---

# DESIGN.md Writer

DESIGN.md tells an agent how the system is built: which parts exist, what each owns, how data moves, which rules must hold, and where to make a given change. An agent reads it before it changes structure, then goes back to the code. This skill writes it, updates it, or audits an existing one, in the shape Claude reads best.

Scope: one file (or the split files the size rule names), plus one pointer line in the rules file. It does not edit code, README or CHANGELOG, and it does not write the project's why and scope (that is `ac:project-md-writer`) or its commands and conventions (`ac:claude-md-rules-creator`). The UI token section is what `ac:frontend-design` reads and commits to; when it builds a screen it owns the visual direction, and this skill owns the file's shape. Report adjacent problems instead of fixing them.

## Which DESIGN.md

The name now means two things.

- **Architecture** (default): how the system is built. Everything below applies.
- **Visual identity**: design tokens plus rationale for a UI, in the format Google Labs published for coding agents. Choose it when the user asks for a brand or style spec, or when an existing DESIGN.md opens with YAML tokens. Read `${CLAUDE_SKILL_DIR}/references/visual-identity.md` and follow it instead of the workflow below.
- A project that needs both keeps the visual file as `DESIGN.md`, because the format is named for that file, and writes the architecture doc as `docs/ARCHITECTURE.md` from the same template.

## Where it sits

| Layer | File | Loaded | Holds |
|---|---|---|---|
| Rules | CLAUDE.md, AGENTS.md | every session | commands, conventions, off-limits |
| Why and scope | PROJECT.md | when read | what, scope, constraints |
| How it is built | DESIGN.md | when read | components, flows, invariants, change guide |

DESIGN.md stays out of the always-loaded layer. Claude Code loads every CLAUDE.md from the working directory upward in full at launch and an `@import` costs the same, so a pointer line with a trigger is the cheaper wiring.

## Pick the mode

- No design doc exists: write.
- One exists and is mostly right: update in place, keep its headings.
- One exists and agents ignore it, or its quality is unknown: audit first and report ranked findings with line numbers; edit only when the user asked for the fix.

## Workflow

### 1. Find what exists

Glob `DESIGN.md`, `ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/architecture*`; read the README, PROJECT.md and CLAUDE.md. Keep an existing location; otherwise use `docs/DESIGN.md`. Check which kind an existing DESIGN.md is.

Success: you know the mode, the kind, the target path and what other files already say.

### 2. Map the code

Open the entry points, the module boundaries, the schema and the tests. Use `ac:explore` for a large repo and LSP for symbol-level questions. Never describe a component you have not opened. Ask the user, with AskUserQuestion in their language and your best guess first, only what the code cannot show: why a boundary sits where it does, and which alternatives were rejected.

If you cannot ask (a subagent or a non-interactive run), omit what only the user knows and list the open question in the report.

Success: you can name each component's responsibility and its dependencies from files you read.

### 3. Write from the template

Read `${CLAUDE_SKILL_DIR}/assets/DESIGN.template.md` and fill it per the section contract. `${CLAUDE_SKILL_DIR}/references/example.md` shows a filled one; match its register.

Success: no placeholder left, no empty section, target 250 lines or fewer.

### 4. Verify

Glob every path you cited, Grep every symbol, and run or read every verification command in the Invariants table. Delete what you cannot confirm.

Success: each claim traces to a file, a symbol or a command output.

### 5. Wire the pointer

Add one line to the rules file if none points here: "Before changing structure, read <target path>; update it in the same change when a component, flow or invariant moves." Put it in CLAUDE.md when one exists; use AGENTS.md only when the project has no CLAUDE.md, because Claude Code reads only the CLAUDE.md files when both exist. Use a plain path, not an `@import`.

Success: `grep -n DESIGN.md` on the rules file finds the line.

## Section contract

| Section | Holds | Rule |
|---|---|---|
| Overview | One paragraph and at most one text diagram | Under 20 lines of diagram; boundaries and data direction only |
| Components | Per component: location, responsibility, depends on, local invariants (omit when none) | Responsibilities and boundaries, never a file inventory; a rule that spans components goes in Invariants |
| Data flow | The two or three main paths, as numbered steps | Each step names `path` or `path:symbol` |
| Data model | Entities that matter and their relations | Point to the schema file; do not copy it |
| Interfaces | External APIs, events, file formats | Point to the source; add invariants types cannot express |
| Invariants | Cross-cutting rules: rule, why, how to verify | The verify column is a test name or a command; component-local rules stay on the component |
| Decisions | Design choices with reason and rejected alternatives | Product and scope choices live in PROJECT.md; each decision has one home |
| Errors and testing | The error contract and where tests live | Two to five lines |
| Change guide | Task, files to touch, coupled places to check | The section agents use most; write it from real changes |
| Known gaps | Debt and unfinished seams | One line each, with the path |
| Last reviewed | Date and trigger | Stamp on every edit |

## Rules

- Document design, not inventory. The code already shows file trees and function lists; record responsibilities, boundaries, flows and invariants.
- Record only what code, git history and the README do not already show. Test each line: would an agent put a change in the wrong place without it?
- State what is true now. No aspirations, no roadmap, no progress; a stale doc is worse than none.
- Anchor to paths and symbol names, never line numbers.
- Give each fact one home. Point to the schema, the config or PROJECT.md instead of copying.
- Keep the headings exactly as in the contract, so agents can grep them. Prefer tables and numbered steps to paragraphs.
- State a rule once with its reason. No capitals for emphasis.
- Over 250 lines, split by component into `docs/design/<component>.md`. DESIGN.md keeps Overview, the diagram, one linked line per component, Decisions and the Change guide.
- Write in the project's documentation language, English by default.

## Update rules

Update DESIGN.md in the same change as the code when a change:

1. Adds, removes or renames a component.
2. Moves a boundary or a dependency.
3. Alters a main data flow.
4. Breaks or adds an invariant.
5. Makes a Change guide row wrong.

Then refresh the Last reviewed stamp. A change that touches none of these needs no edit.

## Audit checklist

- Every cited path and symbol exists.
- Components describe responsibilities, not file listings.
- Every invariant has a verify entry that runs.
- The Change guide covers the last few real changes in the git log.
- No decision also lives in PROJECT.md.
- No status, roadmap or aspiration lines.
- Under 250 lines, or split.
- A pointer from the rules file exists.

## References

| File | Load when |
|---|---|
| `${CLAUDE_SKILL_DIR}/assets/DESIGN.template.md` | Writing or restructuring an architecture doc |
| `${CLAUDE_SKILL_DIR}/references/example.md` | Matching register and level of detail |
| `${CLAUDE_SKILL_DIR}/references/visual-identity.md` | The file is a UI token spec |

Basis for the format: Kiro's spec design phase (`https://kiro.dev/docs/specs/index`: system architecture, data flow, error handling and testing strategy), Anthropic's memory docs (`https://code.claude.com/docs/en/memory.md`) and context engineering article (`https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`). The Invariants table with a verify column, the Change guide and the update-in-the-same-change rule are this skill's own additions.
