# Rules Writing: `.claude/rules/` Deep Dive

When to split CLAUDE.md into `.claude/rules/`, how to pick `paths:` globs, topic-file conventions, recursive subdir layout, symlinks for cross-project sharing, and the token-cost math that drives sizing decisions, plus community benchmarks from HumanLayer, Boris Cherny's team tips, ChrisWiles, and Anthropic's official docs.

## Contents

- When to use `.claude/rules/` (vs inline in CLAUDE.md)
- The two rule types: unconditional and path-scoped
- `paths:` vs `globs:` (they are NOT the same)
- Glob pattern reference
- Path-scoped rule lifecycle (when each fires, when each persists)
- Token cost math
- Splitting strategy: turning a 400-line CLAUDE.md into rules
- Topic-file naming and one-topic-per-file
- Subdirectory layout
- Symlink sharing
- User-level rules at `~/.claude/rules/`
- Sizing: file count, file length
- Common topics and templates

## When to use `.claude/rules/` (vs inline in CLAUDE.md)

A 400-line CLAUDE.md and four 100-line `.claude/rules/<topic>.md` files (all unconditional, no `paths:`) cost EXACTLY the same in tokens at session start. They are concatenated into the same `<system-reminder>` user message at `messages[0]`. Splitting is for HUMAN maintainability and for the OPTION to add `paths:` later.

Use `.claude/rules/<topic>.md` when:

- The team wants a focused file for a topic (testing, security, api, frontend) that one maintainer owns.
- The rule only matters for some files. Adding `paths:` defers it from sessions that do not touch those files.
- Different parts of the codebase have different conventions (frontend vs backend in a monorepo).
- You want to share a rule set across projects via symlinks (`~/shared-claude-rules/` link into each project).

Stay inline in CLAUDE.md when:

- The rule is universal AND the CLAUDE.md is under 200 lines (no maintenance pressure).
- The rule is the project preface: stack, build/test commands, off-limits paths. Always loads, always cheap.

A pragmatic mental model:
- **CLAUDE.md**: onboarding brief. What every contributor needs to know to start the project.
- **`.claude/rules/<topic>.md`**: focused chapters of a coding standards handbook.

## The two rule types

`.claude/rules/<topic>.md` files come in two flavors, controlled by frontmatter:

**Unconditional** (no `paths:`, or `paths: ['**']`):

```markdown
# Testing

- Tests live next to the source file (Component.tsx + Component.test.tsx).
- Run a single test with `pytest -k 'test_name'`.
- Mock external services; never hit real APIs in tests.
- Bug fixes need a regression test that fails without the fix.
```

Loads at session start, alongside `.claude/CLAUDE.md`. Same priority. Identical token cost to inlining. The win is one focused file with one maintainer.

**Path-scoped** (with `paths:`):

```markdown
---
paths:
 - "src/api/**/*.ts"
 - "tests/api/**/*.ts"
---

# API Conventions

- Endpoints validate input with Zod schemas in `src/api/schemas/`.
- Return consistent error responses: `{ error: { code, message } }`.
- Log errors with request ID, user ID, endpoint. Never log tokens or passwords.
- Add rate limiting to public endpoints.
```

Loads on demand when Claude READS a matching file via the Read tool. Once loaded, persists in conversation context for the rest of the session. See "Path-scoped rule lifecycle" below.

## `paths:` vs `globs:`: they are NOT the same

Critical distinction: only the `paths:` key is recognized by the loader. Any other key (including `globs:`) is silently ignored and the rule loads UNCONDITIONALLY at session start.

```markdown
---
paths:
 - "src/api/**"
---
```

Conditional. Loads only when Claude reads a file under `src/api/`.

```markdown
---
globs:
 - "src/api/**"
---
```

Unconditional. Loads at session start every session, regardless of which files Claude touches. The `globs:` key is ignored; the rule is treated as if it had no frontmatter.

Community report: this is the most common rules mistake. People copy a `globs:` example from a tutorial (some early docs used `globs:`), assume the rule is scoped, then wonder why context fills up. Use `paths:`.

The loader also normalizes one shape: `paths: ['**']` is treated identically to no `paths:` (i.e., unconditional): "If all patterns are ** (match-all), treat as no globs". Do not use `paths: ['**']` thinking it will scope; it does not.

## Glob pattern reference

Glob syntax is gitignore-compatible. Common patterns:

| Pattern | Matches |
|---------|---------|
| `**/*.ts` | All TypeScript files in any directory |
| `src/**/*` | All files under `src/` recursively |
| `*.md` | Markdown files in the project root only |
| `src/components/*.tsx` | Direct children of `src/components/` (not nested) |
| `**/*.{ts,tsx}` | TypeScript and TSX files everywhere (brace expansion) |
| `src/api/**` | Anything under `src/api/`, regardless of extension |
| `tests/**/*.test.*` | Test files under `tests/` with any test-extension |

Multiple patterns in a list are OR-matched:

```markdown
---
paths:
 - "src/**/*.ts"
 - "src/**/*.tsx"
 - "tests/**/*.test.ts"
---
```

Pattern resolution base directory:

- **Project rules** (`<dir>/.claude/rules/<topic>.md`): globs are relative to `dirname(dirname(rulesDir))`, i.e., the parent of `.claude/`. So `paths: ['src/api/**']` in `<project>/.claude/rules/api.md` matches `<project>/src/api/...`.
- **Managed and User rules**: globs are relative to the loader, the directory where Claude Code was launched.

Special-case removal: a pattern ending in `/**` has the `/**` stripped, because the `ignore` library treats a path as matching both the path itself and everything inside it. `paths: ['src/api/**']` is internally the same as `paths: ['src/api']`.

Paths that escape the base (`./`) or that are absolute (cross-drive on Windows produces absolute) are filtered out and never match.

## Path-scoped rule lifecycle

When each path-scoped rule fires, when it stops firing, and what tools trigger it. and the loader:

1. **Discovery**: At session start, the loader lists every `.claude/rules/*.md` file in the directories from filesystem root down to cwd. Files with `paths:` are HELD BACK from the initial `<system-reminder>` user message; files without are inlined.
2. **Activation**: When Claude uses the Read tool to read a file, the runtime checks every held-back rule's globs against that path. Matching rules get appended to the tool result as `<system-reminder>`-wrapped attachments.
3. **Persistence**: Once a rule is appended, it lives in the conversation context for the rest of the session. The loader tracks the loader so it does not double-inject. Rules do NOT scope out when Claude moves to other files.
4. **Tool sensitivity**: Only the READ tool triggers path-scoped rules. Edit, Write, MultiEdit, NotebookEdit do NOT trigger them. If Claude edits a file without reading it first, the rule is silent. (This is a longstanding issue: anthropics/claude-code#23478.)
5. **Compact**: `/compact` summarizes the conversation. Path-scoped rules in the message stream are summarized away. They reload when Claude next reads a matching file.

Practical implication: if a rule MUST hold whenever a file changes (not just when read), do not rely on `paths:`. Options:

- Make the rule unconditional (load at session start, always in context).
- Move enforcement to a `PostToolUse` hook on `Write|Edit|MultiEdit` (deterministic, no model judgment).
- Add a CLAUDE.md note that says "before editing files under `src/api/`, ALWAYS read one first" (works only if the model follows the instruction).

## Token cost math

Path-scoped rules are NOT in the cached `messages[0]` user message. They live in the message stream. Every API request after a rule loads has that rule in conversation history.

Community-reported math from a real session (anthropics/claude-code#32057):

| Component | Tokens | Percent of 200K |
|-----------|-------:|----------------:|
| Initial load (system prompt + CLAUDE.md + unconditional rules) | ~43K | 21 percent |
| 11 conditional rule files persisting across ~30 tool calls | ~93K | 46 percent |
| Conversation content (turns, tool results, files read) | ~50K | 25 percent |

The rule files themselves are ~6,200 tokens total. They cost 93K because they sit in conversation history for the latter part of the session, and prompt caching does not apply to attachments the same way it applies to `messages[0]`.

This is why the community benchmarks recommend:

- **3 to 5 rule files maximum** (HumanLayer, Boris Cherny's team, ChrisWiles - all converge on this).
- **Each rule file under 30 lines** (or as short as the topic allows).
- **Use `paths:` aggressively** so rules do not load on sessions that do not need them.
- **For genuinely universal rules**, inline them in CLAUDE.md instead of `.claude/rules/<topic>.md` without `paths:` - same content, but in the cached message slot.

If a rule file grows past 30 lines, it is probably covering multiple topics. Split.

## Splitting strategy: turning a 400-line CLAUDE.md into rules

Walk these in order.

**1. Identify the universal core.** What does EVERY session need? Stack, build/test commands, off-limits paths, repo etiquette, architectural decisions. This stays in CLAUDE.md. Aim for 40 to 80 lines.

**2. Group remaining content by topic.** Common topics:

- Testing conventions
- Code style (only if no linter; otherwise use the linter)
- Security and authentication patterns
- API design (routes, response shapes, error handling)
- Database (migrations, query patterns, ORM use)
- Frontend (components, styling, accessibility)
- Background jobs / async patterns
- Logging and observability
- Deployment

**3. Decide path-scoping for each topic.** For each candidate rule file:

- Is the rule relevant in EVERY session? (No `paths:` - unconditional.)
- Is the rule relevant only when working on certain files? (Add `paths:` matching those files.)
- If the answer is "always relevant but the file is large", split further. A 30-line rule is better than a 100-line one.

**4. Write each rule file under 30 lines.** Drop the "would Claude make a mistake without this?" test on each line. Cut aggressively.

**5. Remove duplicates between CLAUDE.md and rule files.** Each rule lives in exactly one place. Duplication burns the attention budget.

**6. Add the `paths:` frontmatter for path-scoped files.** Use the most specific glob that captures the intent.

**7. Run `/memory` to verify.** Every file should appear in the loaded list. If a file is missing, the path is wrong; if it appears but the model is not following it, see the troubleshooting checklist in `loader-and-injection.md`.

Before/after sketch for a hypothetical 350-line CLAUDE.md:

```
Before: After:

CLAUDE.md (350 lines, all unconditional) CLAUDE.md (55 lines: stack, commands, off-limits, repo etiquette)
.claude/
 ├── CLAUDE.md (skip - keep root only)
 └── rules/
 ├── testing.md (25 lines, no paths: - universal)
 ├── api.md (28 lines, paths: ["src/api/**"])
 ├── frontend.md (22 lines, paths: ["src/components/**", "src/app/**"])
 ├── migrations.md (15 lines, paths: ["prisma/migrations/**", "db/migrations/**"])
 └── security.md (18 lines, no paths: - universal)
```

Total: 55 + 25 + 18 = 98 lines always loaded (universal core). Other rules load only when relevant.

## Topic-file naming and one-topic-per-file

Naming conventions (from community examples):

- One topic per file. `testing.md`, `api-design.md`, `code-style.md`, `migrations.md`, `frontend.md`.
- Lowercase, hyphen-separated. Avoid uppercase or underscores.
- Avoid mixing topics. `api-and-testing.md` is a smell; split.
- Subdirectory the namespace if the layout warrants it: `frontend/react.md`, `frontend/styles.md`, `backend/api.md`, `backend/db.md`. The loader is recursive so subdirs work fine.

Anti-pattern: `everything.md`. Defeats the purpose. If you have a kitchen-sink rule file, you have one CLAUDE.md sitting in the wrong directory.

## Subdirectory layout

the loader is recursive. Subdirectories under `.claude/rules/` are walked, and `.md` files in them are loaded. Cycles are detected (`visitedDirs` Set).

```
.claude/rules/
├── code-style.md
├── testing.md
├── frontend/
│ ├── react.md
│ ├── styles.md
│ └── accessibility.md
├── backend/
│ ├── api.md
│ ├── database.md
│ └── jobs.md
└── security.md
```

Each file's `paths:` is relative to the project root, NOT to the rule file's directory. So `frontend/react.md` with `paths: ['src/components/**']` correctly matches files in `<project>/src/components/`, not in `.claude/rules/frontend/src/components/`.

## Symlink sharing

`.claude/rules/` supports symlinks (`utils/claudemd.ts:719-727, 743-751`). Symlinks resolve normally; circular symlinks are detected via `resolvedPath` tracking.

Use case: share a rule set across projects.

```bash
# Maintain shared rules in ~/shared-claude-rules/
mkdir -p ~/shared-claude-rules
echo "Rules go here." > ~/shared-claude-rules/security.md

# Link into each project
ln -s ~/shared-claude-rules.claude/rules/shared
# or symlink individual files
ln -s ~/shared-claude-rules/security.md.claude/rules/security.md
```

Updates to `~/shared-claude-rules/` are reflected in every linked project immediately.

## User-level rules at `~/.claude/rules/`

Personal rules apply to every project. and, the user rules dir is `~/.claude/rules/` - NOT `~/.claude/.claude/rules/`. One level shallower than project rules.

```
~/.claude/rules/
├── preferences.md Your personal coding preferences
├── workflows.md Your preferred workflows
└── communication.md Be terse, don't summarize at the end, etc.
```

User-level rules are loaded BEFORE project rules in the walk-up. Project rules appear later in the concatenation; on conflict, project wins (the model weights later content more). This means your personal rules act as defaults that the project can override per-codebase.

Use user-level rules for:
- Communication preferences ("be terse", "use file:line citations", "no end-of-turn summary").
- Cross-project workflow ("always run tests after changes").
- Personal tooling ("prefer `pnpm` over `npm`, prefer `uv` over `pip`").
- Personal package preferences ("avoid lodash, use native JS").

Do NOT use user-level rules for project-specific or team-specific content. That belongs in `./CLAUDE.md` or `./.claude/rules/`.

## Sizing benchmarks

| Source | Lines | Note |
|--------|-------|------|
| Anthropic official guidance | < 200 per file | Soft cap; adherence drops past this |
| HumanLayer CLAUDE.md | 57 | Real production file, public on GitHub |
| ChrisWiles claude-code-showcase | 80 | 5.2k stars community example |
| Boris Cherny team file | ~83 | Private repo; cited in Boris's posts |
| Cloudflare templates | 230 | Enterprise monorepo; too long for most projects |
| Anthropic's `/init` example | ~10 | Deliberately tiny: just code style + workflow |
| Community sweet spot | 40 to 80 | Target unless you have a specific reason to go longer |

For rule files: 3 to 5 files total per project, each under 30 lines. This is conservative; many projects can do with 2 or even 0 rule files. If you find yourself at 6+ rule files or 50+ lines per file, audit which lines actually pass the "would Claude make a mistake without this?" test.

The hard cap is 40,000 characters per file (`MAX_MEMORY_CHARACTER_COUNT`). The loader warns past this but does not block.

## Common topics and templates

Production-quality starters for common rule files. Adapt to your stack.

**testing.md** (path-scoped or universal, your call):

```markdown
---
paths:
 - "tests/**"
 - "**/*.test.*"
 - "**/*.spec.*"
---

# Testing

- Run a single test with `pytest -k 'test_name'` (or `npm test -- --grep`).
- Mock external services (APIs, payment gateways). Never hit real APIs in tests.
- Every bug fix includes a regression test that fails without the fix.
- Tests live next to source files: `Component.tsx` + `Component.test.tsx`.
- Run full suite before marking a task done: `npm test`.
```

**api.md** (path-scoped):

```markdown
---
paths:
 - "src/api/**"
 - "src/routes/**"
 - "app/api/**"
---

# API Conventions

- Validate every input at the boundary with Zod (or your validation lib).
- Return error responses as `{ error: { code, message } }`. Never bare strings.
- Status codes: 201 for creation, 404 for not found, 422 for validation errors.
- Route handlers stay thin. Extract business logic into `src/services/`.
- Log with request ID, user ID, endpoint. Never log tokens, passwords, secrets.
- Add rate limiting to public-facing endpoints.
```

**frontend.md** (path-scoped):

```markdown
---
paths:
 - "src/components/**/*.tsx"
 - "src/app/**/*.tsx"
---

# React Components

- Use functional components. No class components.
- Props interface named `ComponentNameProps`. Always export it.
- Named exports only. No default exports.
- Server Components by default. `'use client'` only when needed (hooks, browser APIs).
- Memoize only when profiling shows a benefit.
- Co-locate tests and styles: `Component.tsx`, `Component.test.tsx`, `Component.module.css`.
```

**migrations.md** (path-scoped):

```markdown
---
paths:
 - "prisma/migrations/**"
 - "db/migrations/**"
 - "alembic/versions/**"
---

# Database Migrations

- Generate migrations with the ORM CLI; never edit migration files directly.
- One logical change per migration.
- Migrations are append-only. To undo, write a new forward migration.
- Always test against a copy of production data before merging.
- Coordinate with on-call before merging migrations that lock tables.
```

**security.md** (usually unconditional):

```markdown
# Security

- Never log credentials, tokens, session IDs, or PII.
- Never commit `.env` files or any file containing secrets.
- Validate untrusted input at the boundary. Sanitize before rendering.
- Use parameterized queries; never string-concatenate SQL.
- Treat user-supplied URLs as untrusted; do not fetch without validation.
```

Adapt the paths and conventions to your project. The point is one topic per file, focused content, short.
