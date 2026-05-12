# Content Rules: What to Include, What to Exclude

Comprehensive INCLUDE / EXCLUDE list with examples, the five-question framework, specificity rules, the verification-loop pattern, the self-improvement loop, and the emphasis-keyword guidance. Synthesizes Anthropic's official best-practices doc, the `/init` command prompt, HumanLayer's research, Boris Cherny's team tips, and the community benchmarks (HumanLayer, ChrisWiles, Cloudflare).

## Contents

- The "would removing this cause Claude to make mistakes?" test
- Anthropic's official INCLUDE / EXCLUDE table
- The five-question framework
- Specificity: vague vs verifiable
- The verification-loop pattern
- The self-improvement loop
- Emphasis keywords (`IMPORTANT:`, `YOU MUST`, `NEVER`)
- The "Don't X, Do Y" rule
- "Never send an LLM to do a linter's job"
- ASCII architecture diagrams
- TODO priority systems
- Skill activation mapping
- Plan-mode hints
- The canonical project preface
- What `/init` includes by default

## The "would removing this cause Claude to make mistakes?" test

Apply this test to every line you consider adding to CLAUDE.md or `.claude/rules/`. If the answer is "no, the model would still do the right thing", cut the line.

Every line you add competes with every other line for the model's attention. Anthropic's docs and Claude Code's harness tell the model your CLAUDE.md "may or may not be relevant". When the file is bloated, the model does not selectively ignore the bad lines; it starts ignoring all of them uniformly.

The math is simple: every line you add makes every other line less likely to be followed.

This test is the single most important habit. It is more impactful than any specific include/exclude rule below.

## Anthropic's official INCLUDE / EXCLUDE table

| Include | Exclude |
|---------|---------|
| Bash commands Claude cannot guess | Anything Claude can figure out by reading code |
| Code style rules that DIFFER from language defaults | Standard language conventions Claude already knows |
| Testing instructions and preferred runners | Detailed API documentation (link to it instead) |
| Repository etiquette (branch naming, PR conventions) | Information that changes frequently |
| Architectural decisions specific to project | Long explanations or tutorials |
| Developer environment quirks | File-by-file descriptions of the codebase |
| Common gotchas or non-obvious behaviors | Self-evident practices like "write clean code" |
| Non-default env vars or required setup | Onboarding prose for humans (use README) |
| Important parts from other AI-tool configs | Credentials, secrets, anything sensitive |
| Verification commands (test, lint, type-check) | Aspirational rules ("we aim for 90% coverage") |

The test: "Could Claude figure this out by reading my code?" If yes, do not add it.

Detailed walk-through for each row below.

### INCLUDE: Bash commands Claude cannot guess

Non-standard scripts, flags, or sequences. Even one obscure command saves a session of trial and error.

```markdown
- Run a single test: `pytest -k 'test_name' -xvs --no-cov`
- Migrate the dev database: `pnpm db:migrate:dev` (NOT `prisma migrate dev` - the wrapper sets up seed data)
- Run typecheck without emitting: `npx tsc --noEmit`
- Start the dev server with verbose logs: `DEBUG=app:* pnpm dev`
```

EXCLUDE if standard:

```markdown
# Don't write this:
- Install dependencies: `npm install`
- Run tests: `npm test`
```

The agent finds `npm install` and `npm test` from `package.json`. The line burns tokens for content the agent already knows.

### INCLUDE: Code style rules that DIFFER from language defaults

```markdown
- Prefer `type` over `interface` in TypeScript (project convention).
- No `any`. Use `unknown` and narrow with type guards or assertions.
- Named exports only. No default exports.
- Co-locate component tests: `Foo.tsx` and `Foo.test.tsx` in the same directory.
```

EXCLUDE if it is the language default:

```markdown
# Don't write this:
- Python uses snake_case for functions.
- JavaScript uses camelCase for variables.
- Use semicolons at the end of statements.
```

The model knows these. The lines are pure tax.

### INCLUDE: Testing instructions and preferred runners

```markdown
- Run a single test: `pytest -k 'test_name'`
- Tests need a local Redis instance: `docker compose up redis`
- Never hit real APIs in tests; mock them with `responses` or `httpx-mock`.
- Bug fixes need a regression test that fails without the fix.
```

EXCLUDE generic test prose:

```markdown
# Don't write this:
- Write good tests.
- Test edge cases.
- Aim for high coverage.
```

### INCLUDE: Repository etiquette

```markdown
- Branch naming: `feat/<description>`, `fix/<description>`, `chore/<description>`.
- Conventional commits with scope: `feat(api):.`, `fix(web):.`.
- PRs require one review. No direct pushes to `main`.
- Squash merge only.
```

### INCLUDE: Architectural decisions

```markdown
- Event sourcing. Emit events; do not mutate state directly.
- Thin controllers, fat services. Route handlers delegate to `src/services/`.
- API endpoints validate input with Zod schemas in `src/api/schemas/`.
- Database access only through repositories in `src/repositories/`, never raw SQL in route handlers.
```

### INCLUDE: Non-obvious gotchas

```markdown
- The migration runner caches schemas; clear `.cache/` after schema changes.
- WebSocket handlers must register cleanup, or the test suite hangs.
- `prisma generate` after every schema change; the CI fails if the generated client is stale.
- `next dev` ignores `.env.production`; use `.env.local` for local dev.
```

These are the highest-leverage lines. Each one saves a session of debugging.

### INCLUDE: Important parts from other AI-tool configs

If the repo has `AGENTS.md`, `.cursor/rules`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, or `.clinerules`, either:

- Use `@AGENTS.md` to import (best if AGENTS.md is the source of truth).
- Inline the parts that matter (best if you want Claude-specific overlay).

Do not duplicate; pick one source of truth.

### EXCLUDE: File-by-file structure

```markdown
# Don't write this:
- `src/index.ts` is the entry point.
- `src/routes/users.ts` handles user routes.
- `src/routes/posts.ts` handles post routes.
- `src/utils/form ts` contains formatting helpers.
```

The agent reads files. It does not need a tour. List directories only when their meaning is non-obvious:

```markdown
# DO write this:
- `src/jobs/` runs in a separate worker process (BullMQ).
- `src/lib/` is server-only; do not import from client components.
- `apps/web/` is the Next.js app, `apps/api/` is the standalone Express API.
```

### EXCLUDE: Generic platitudes

```markdown
# Don't write this:
- Write clean code.
- Handle errors properly.
- Test your changes.
- Follow best practices.
```

The model cannot verify these and will not follow them. They are aspirations, not instructions.

### EXCLUDE: Detailed API documentation

```markdown
# Don't write this in CLAUDE.md:
## API Reference
### POST /users
Body: { name, email, password }
Response: { id, name, email }
.
[100 more lines of API docs]
```

API docs change faster than CLAUDE.md and drift. Either:

- Use `@docs/api-reference.md` to import (loads every session at startup cost).
- Pitch: "For the API reference, read." (loads only when relevant.)

Pitch is better for content that is only sometimes relevant.

### EXCLUDE: Onboarding prose for humans

README is for humans. CLAUDE.md is for the agent. Different density, different content. If you copy README into CLAUDE.md, you waste tokens on background context the agent does not need.

### EXCLUDE: Secrets

CLAUDE.md is committed to the repo. Never include API keys, tokens, passwords, internal URLs, customer data. Treat it like code.

For per-developer secrets, put them in `CLAUDE.local.md` (gitignored), and even there only stuff that is not actually sensitive (sandbox URLs, dev credentials with no production access).

### EXCLUDE: Aspirational rules

```markdown
# Don't write this:
- We aim for 90% test coverage.
- We strive for fast response times.
- We are moving towards full type coverage.
```

The model cannot verify aspirations and will write irrelevant code trying to satisfy them ("here are 50 trivial tests to hit coverage"). State what is actually enforced:

```markdown
# DO write this:
- CI fails if test coverage drops below 80%. Run `pnpm coverage` to check.
- Type coverage is enforced by `tsc --strict` in CI. Run `npx tsc --noEmit` locally.
```

## The five-question framework

A pragmatic frame: every project CLAUDE.md should answer these five.

1. **What is the stack?** One paragraph: language, framework, runtime, package manager, key libraries.

 ```markdown
 ## Stack
 Python 3.12, FastAPI, SQLAlchemy 2.0, PostgreSQL, Redis, uv for package management.
 ```

2. **Where does code live?** Top-level directories with one-line meanings - only when non-obvious.

 ```markdown
 ## Structure
 - `src/api/` - route handlers (thin, delegate to services)
 - `src/services/` - business logic
 - `src/models/` - SQLAlchemy ORM models
 - `tests/` - pytest tests, mirrors `src/` structure
 ```

3. **How do I run things?** Dev server, tests, lint, type-check, build, deploy. Exact strings.

 ```markdown
 ## Commands
 - Dev: `uv run fastapi dev`
 - Test: `uv run pytest`
 - Lint: `uv run ruff check.`
 - Format: `uv run ruff form `
 - Type check: `uv run mypy src/`
 - Migrate: `uv run alembic upgrade head`
 ```

4. **What are the conventions?** Style rules that differ from defaults, naming patterns, architectural rules.

 ```markdown
 ## Conventions
 - Type hints on all functions (params + return).
 - Pydantic models for all API input/output; never return raw dicts.
 - Async everywhere: `async def` for route handlers and services.
 - Dependency injection via FastAPI's `Depends`; no global state.
 ```

5. **What is off-limits?** "Do not edit X", "never push directly to Y", "do not run Z".

 ```markdown
 ## Off-limits
 - Do not edit `alembic/versions/*` directly; generate via `alembic revision --autogenerate`.
 - Never push directly to `main`; PRs only.
 - Do not run `pip install` (use `uv add`).
 ```

If your CLAUDE.md does not answer these five, add the missing ones. If it answers more than five, audit whether the extras pull their weight.

## Specificity: vague vs verifiable

The model follows concrete instructions better than vague ones. For each rule, ask: "Could I check whether the model followed this by looking at the output?"

```markdown
# Too vague:
- Write good error handling.

# Specific and verifiable:
- Catch specific exceptions, not bare `Exception`. Log full context (operation, args, user ID). Return a typed error response.
```

```markdown
# Too vague:
- Use proper validation.

# Specific and verifiable:
- Validate API input with Zod schemas in `src/api/schemas/`. Reject with 422 on validation error.
```

```markdown
# Too vague:
- Format code properly.

# Specific and verifiable:
- Use 2-space indentation. Prefer single quotes. Trailing commas in multi-line arrays.
- (Better still: configure prettier/biome/ruff and remove this rule entirely.)
```

## The verification-loop pattern

From Boris Cherny's #1 tip and Anthropic's official best practices: give Claude a way to verify its own work. Models with a feedback loop produce 2 to 3 times better results.

Include explicit verification commands in CLAUDE.md. Order matters (cheap first):

```markdown
## Verification

After every change, run in this order:
1. `npx tsc --noEmit` - fix type errors
2. `npm test` - fix failing tests
3. `npm run lint` - fix lint errors
4. `npm run build` - confirm it builds
```

Or for Python:

```markdown
## Verification

After every change, run in this order:
1. `uv run mypy src/` - fix type errors
2. `uv run pytest` - fix failing tests
3. `uv run ruff check.` - fix lint errors
```

The model runs these, sees errors, fixes them, re-runs. The loop self-corrects before you review. Anthropic's docs: "Include tests, screenshots, or expected outputs so Claude can check itself. This is the single highest-leverage thing you can do."

## The self-improvement loop

From Boris Cherny's tip #3: after every correction you give Claude, end with:

> "Update CLAUDE.md so you don't make that mistake again."

The model writes a specific rule. You review and sharpen it. The mistake never happens again. Over weeks, CLAUDE.md accumulates the team's institutional knowledge.

Habit, not configuration. The skill cannot enforce this; you have to do it. But you can add a meta-rule to CLAUDE.md to remind yourself:

```markdown
## Self-improvement

When the agent makes a mistake that future sessions would repeat, end the correction with: "Update CLAUDE.md so you don't make that mistake again." Then review the proposed rule and edit it down before committing.
```

## Emphasis keywords

Anthropic confirms emphasis works WHEN USED SPARINGLY. The runtime already supplies authority via `MEMORY_INSTRUCTION_PROMPT` at the top: "IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written."

Reserve emphasis keywords for 2 or 3 rules that truly matter:

```markdown
- IMPORTANT: never log tokens, passwords, or PII.
- YOU MUST run `npm test` before marking any task complete.
- NEVER push directly to `main`; PRs only.
```

If every rule is `IMPORTANT`, none of them are. The model treats them uniformly. Use plain prose for the other 95% of rules; let specificity carry weight.

## The "Don't X, Do Y" rule

Every prohibition needs a replacement. Negative-only instructions leave the model guessing:

```markdown
# Bad: model does not know what to do instead
- NEVER use `any` in TypeScript.

# Good: model knows the alternative
- NEVER use `any` in TypeScript. Use `unknown` and narrow with type guards or assertions.
```

```markdown
# Bad:
- Don't write inline styles in React.

# Good:
- Don't write inline styles in React. Use Tailwind classes; for dynamic styles, use `clsx` with utility classes.
```

```markdown
# Bad:
- Avoid global mutable state.

# Good:
- Avoid global mutable state. Pass state explicitly via React context or props; for cross-page state, use the database.
```

## "Never send an LLM to do a linter's job"

Formatting and style rules belong in a linter or formatter, not in CLAUDE.md. The linter is deterministic; the LLM is not.

```markdown
# Don't write these in CLAUDE.md (use a linter):
- Use 2-space indentation.
- Always add trailing commas.
- Sort imports alphabetically.
- Use single quotes for strings.
```

Configure prettier/biome/ruff to enforce these. Then CLAUDE.md can mention:

```markdown
- Run `pnpm format` (prettier) before committing.
```

EXCEPTION: if the project has NO formatter configured, concrete style rules in CLAUDE.md are exactly what Anthropic's docs recommend. "Use 2-space indentation" is specific and verifiable; the model will follow it.

The principle: configure deterministic tools for deterministic rules; reserve CLAUDE.md for judgment calls and project-specific context.

## ASCII architecture diagrams (HumanLayer pattern)

For monorepos and multi-service architectures, a one-line ASCII diagram is dramatically cheaper than paragraphs:

```markdown
## Architecture

Claude Code -> MCP Protocol -> hlyr -> JSON-RPC -> hld -> Cloud API

Request flow: client -> CDN -> API gateway -> Lambda -> DynamoDB
Webhook flow: GitHub -> API gateway -> SQS -> worker Lambda -> Slack
```

The model picks up spatial understanding from these lines without consuming many tokens. Especially useful for:

- Service-to-service request/response flows
- Data pipelines
- Module dependency chains
- Auth or webhook flows

## TODO priority systems (HumanLayer pattern)

If your team uses TODO annotations, document them so the model uses them consistently:

```markdown
## TODO annotations

- `TODO(0)`: critical - never merge with these
- `TODO(1)`: high - architectural flaws, major bugs
- `TODO(2)`: medium - minor bugs, missing features
- `TODO(3)`: low - polish, tests, documentation
- `TODO(4)`: questions or investigations needed
- `PERF`: performance optimization opportunity
```

The model writes consistent TODOs across new code if the convention is in CLAUDE.md.

## Skill activation mapping (ChrisWiles pattern)

Tell Claude which skill to load for which task. Lightweight progressive disclosure:

```markdown
## Skills

- Creating tests -> use `testing-patterns` skill
- Building forms -> use `formik-patterns` skill
- GraphQL operations -> use `graphql-schema` skill
- Debugging issues -> use `systematic-debugging` skill
```

Costs nearly nothing in context (a few lines). Moves task-specific knowledge into skills that load on demand. Compare to inlining the patterns: paying for testing patterns in every session even when no tests are written.

## Plan-mode hints (Matt Pocock pattern)

Two lines that change planning behavior:

```markdown
## Plan mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give a list of unresolved questions to answer, if any.
```

The "unresolved questions" pattern forces the model to surface what it does not know before proceeding. Tiny addition, big behavior shift.

## The canonical project preface

For team `./CLAUDE.md`, lead with the canonical preface that `/init` writes :

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

This is a convention. Tells human readers what the file is at a glance. The runtime does not require it.

## What `/init` includes by default

 (built-in command).

The OLD `/init` prompt (default unless `NEW_INIT` feature flag is on) tells the model to analyze the codebase and create a CLAUDE.md containing:

1. **Commands** commonly used: build, lint, run tests, run a single test.
2. **High-level architecture**: the "big picture" that requires reading multiple files to understand.

Exclusions:

- Do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- No generic development practices.
- If `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` exist, include the important parts.
- If README.md exists, include important parts.
- Do not make up sections like "Common Development Tasks" or "Tips for Development" unless they are expressly grounded in files the agent read.

The NEW `/init` prompt (per `CLAUDE_CODE_NEW_INIT=1` or ant builds) runs a multi-phase interactive flow: asks what to set up (project CLAUDE.md, personal CLAUDE.local.md, both), asks about skills and hooks, explores the codebase with a subagent, gathers gap-fill info, proposes a setup, and writes everything after user approval. The content rules above still apply.

Practical implication: `/init` is a starting point. The first draft is generic. Edit it down based on what you actually know matters. Anthropic's docs say to use `/init` as the starting point, then refine.
