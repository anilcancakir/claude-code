# Worked Examples

Four annotated examples covering the most common shapes. Each one passes the audit checklist in `anti-patterns.md`: under the size cliff, every line earns its place, no aspirations, no platitudes, no secrets, no file-by-file tours, no standard-language conventions, scope matches audience.

Adapt these to your stack. Copy is fine; verbatim copy is suspicious - your project has its own commands and conventions.

## Contents

- Example 1: User-global `~/.claude/CLAUDE.md`
- Example 2: Project-team `./CLAUDE.md` for a Next.js + Prisma app
- Example 3: Project-personal `./CLAUDE.local.md`
- Example 4: Path-scoped rule `./.claude/rules/api.md`
- Bonus: small monorepo layout with subdir CLAUDE.md and rules

## Example 1: User-global `~/.claude/CLAUDE.md`

12 lines. Personal preferences across every project on this machine. Communication style, package managers, behavior defaults.

```markdown
## Role

You are my pair-programming partner. Write code as if it were yours.

## Output

- Match the language of my message (English, Turkish, or mixed).
- No em-dash or en-dash in any output. Use plain ASCII dashes.
- Code, identifiers, comments, commit messages: English only.

## Tools

- Prefer `pnpm` over `npm`, `uv` over `pip`.
- After any code edit, read LSP diagnostics and fix every error and warning.
- For bug fixes, write the failing reproducer first, then fix until green.
```

Why each line earns its place:
- `## Role` shapes ownership and care. Without it the model defaults to a generic assistant tone.
- Language match avoids switching mid-message.
- Em-dash ban is a verifiable formatting rule for every output.
- English-for-code is the convention I apply across all projects.
- Package managers: I always use `pnpm` / `uv`, but model defaults are `npm` / `pip`.
- LSP loop is the verification loop pattern. 2-3x quality lift per Boris Cherny's #1 tip.
- Red-green for bugs is non-negotiable workflow.

What is NOT in this file:
- Project-specific stack, conventions, commands (those go in project-team CLAUDE.md).
- Aspirations ("write clean code"). Cut.
- Generic platitudes. Cut.
- Persona acting ("be a 10x engineer"). Cut.

## Example 2: Project-team `./CLAUDE.md` for a Next.js + Prisma app

48 lines. Stack, structure, commands, verification, conventions, off-limits, repo etiquette. Under the 80-line target.

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Next.js 15 (App Router), React 19, TypeScript strict, Tailwind 4, Prisma + PostgreSQL, NextAuth.js 5, pnpm 9.

## Structure

- `src/app/` - App Router pages and API routes
- `src/components/` - shared React components (shadcn/ui base)
- `src/lib/` - server-only utilities, DB client, auth helpers
- `src/server/` - server actions and server-side helpers
- `prisma/` - schema, migrations, seed script

## Commands

- Dev: `pnpm dev`
- Build: `pnpm build`
- Test: `pnpm test` (Vitest)
- Lint: `pnpm lint`
- Type check: `pnpm tsc --noEmit`
- DB push (dev only): `pnpm db:push`
- Migration (prod schema change): `pnpm prisma migrate dev --name <slug>`

## Verification

After every change, run in this order:
1. `pnpm tsc --noEmit` - fix type errors
2. `pnpm test` - fix failing tests
3. `pnpm lint` - fix lint errors
4. `pnpm build` - confirm it builds

## Conventions

- Server Components by default. `'use client'` only for hooks, browser APIs, event handlers.
- Use shadcn/ui components. Do NOT install new UI libraries.
- Use Zod for all form validation and API input validation.
- Server Actions for mutations. Route Handlers for external API endpoints.
- Co-locate tests: `Foo.tsx` and `Foo.test.tsx` in the same directory.
- Imports: stdlib, external, internal (`@/`). One blank line between groups.

## Off-limits

- Do NOT edit `prisma/migrations/*` directly. Generate via `pnpm prisma migrate dev`.
- Do NOT push to `main`. PR-only with one review.
- Do NOT use `any`. Use `unknown` and narrow with type guards or assertions.

## Git

- Conventional commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `chore:`.
- Branch naming: `feat/<slug>`, `fix/<slug>`.
- Squash merge only.
```

Why this works:
- Canonical preface at the top tells human readers what the file is.
- Stack in one line. The model uses this to pick correct framework idioms.
- Structure lists ONLY non-obvious meanings. `src/components/` and `src/lib/` are conventional; including them with descriptions still earns its place because the divisions matter (server-only vs shared).
- Commands include only what is NOT obvious from `package.json`. `pnpm prisma migrate dev --name <slug>` is the team's enforced workflow.
- Verification block is the loop. The model self-corrects through it.
- Conventions are specific and verifiable. No "use proper validation"; "use Zod for all form validation and API input validation".
- Off-limits has 3 hard prohibitions, each with the positive alternative (`Don't X. Do Y.`).
- Git etiquette is one line each.

What is NOT here:
- README content (that lives in `README.md`).
- Detailed API documentation (use `@imports` or pitch).
- Aspirations ("we aim for X").
- Standard JS/TS conventions Claude already knows.
- Persona instructions.

## Example 3: Project-personal `./CLAUDE.local.md`

14 lines. Gitignored. Your sandbox URLs, test accounts, branch context, communication preferences. The team does not see this file.

```markdown
## My setup

- I am the maintainer of `src/billing/`. Push back if changes outside `src/billing/` look risky to billing flow.
- Sandbox: http://localhost:3000 (dev), http://staging.example.test (staging).
- Test account: `test+claude@example.com` / see `~/.config/test-creds`.
- I usually work in `feature/billing-refactor`. Default to that branch when I am vague.

## Style

- Be terse. Skip the end-of-turn summary; I read the diff.
- When refactoring `src/billing/`, surface a one-paragraph plan before writing code. I want to approve the approach first.

## Tools

- I have Playwright MCP configured. Use it for UI verification when changes touch `src/app/billing/`.
```

Why this works:
- Role/ownership context calibrates pushback for billing-related changes.
- Sandbox URLs let the model verify locally without asking.
- Test account points at a secret file; the credentials are not in `CLAUDE.local.md` (or anywhere committed).
- Default branch saves me typing it.
- "Be terse" + "skip summary" are my communication preferences for this project (different from other projects).
- The plan-before-code rule for billing is a personal workflow guard.
- Playwright MCP availability is environment context Claude cannot otherwise discover.

Add `CLAUDE.local.md` to `.gitignore` before committing anything else. If the team is using `/init`, it adds the line automatically.

## Example 4: Path-scoped rule `./.claude/rules/api.md`

22 lines. Loads on demand when Claude reads files matching the glob. Use `paths:` (not `globs:`).

```markdown
---
paths:
  - "src/app/api/**/*.ts"
  - "src/server/**/*.ts"
---

# API Conventions

- Validate every input with Zod schemas in `src/server/schemas/`. Reject with 422 on validation error.
- Return errors as `{ error: { code: string, message: string } }`. Never bare strings.
- Status codes: 200 OK, 201 Created, 204 No Content, 400 bad request, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 422 validation, 429 rate-limited, 500 internal.
- Log every error with `requestId`, `userId`, `endpoint`, `errorCode`. Never log tokens, passwords, or PII.
- Route handlers stay thin. Business logic goes in `src/server/services/`.
- Use server actions for mutations from the same Next.js app. Use Route Handlers for external API calls and webhooks.
- Add rate limiting via `src/server/rate-limit.ts` to every public-facing endpoint.

## Auth

- All routes under `src/app/api/admin/*` require `requireAdmin()` from `src/server/auth.ts` as the first call.
- Public routes are listed in `src/server/public-routes.ts`. Anything not in that list is treated as authenticated.

## Testing

- Tests live in `src/app/api/<route>.test.ts` and `src/server/services/<service>.test.ts`.
- Mock external services (Stripe, SendGrid). Never hit real APIs in tests.
```

Why this works:
- Loads only when Claude reads API files. The frontend session never pays for these rules.
- Concrete and verifiable. Every rule names a function, file, or pattern Claude can point at.
- Auth subsection puts the requirement next to the code paths it applies to.
- Testing subsection scopes test conventions to API tests specifically.
- No aspirations, no platitudes, no file-by-file tour.

Common mistakes this avoids:
- Using `globs:` instead of `paths:` (the rule would load every session unconditionally).
- Setting `paths: ['**']` (the loader normalizes to no `paths:` and the rule loads unconditionally).
- Mixing API rules with frontend rules in one file (split by topic).

## Bonus: small monorepo layout

Root file lean, subdir files focused, conditional rules for specific paths.

```
monorepo/
├── CLAUDE.md                            55 lines: stack, repo etiquette, top-level commands
├── .claude/
│   ├── CLAUDE.md                        skip - keep root only, no need for both
│   └── rules/
│       ├── code-style.md                25 lines, no paths: - universal
│       └── security.md                  18 lines, no paths: - universal
├── apps/
│   ├── web/
│   │   ├── CLAUDE.md                    32 lines: web-specific stack, components, styling
│   │   └── .claude/
│   │       └── rules/
│   │           └── react.md             20 lines, paths: ["apps/web/src/**/*.tsx"]
│   └── api/
│       ├── CLAUDE.md                    28 lines: API-specific commands, db conventions
│       └── .claude/
│           └── rules/
│               ├── routes.md            22 lines, paths: ["apps/api/src/routes/**"]
│               └── migrations.md        15 lines, paths: ["apps/api/db/migrations/**"]
└── CLAUDE.local.md                       gitignored, your sandbox URLs + dev creds
```

How loading plays out:

- Working at the monorepo root: root `CLAUDE.md`, root `.claude/rules/{code-style,security}.md`, root `CLAUDE.local.md`.
- Working in `apps/web/`: all of the above PLUS `apps/web/CLAUDE.md`. `react.md` activates when Claude reads a `.tsx` file under `apps/web/src/`.
- Working in `apps/api/`: root files PLUS `apps/api/CLAUDE.md`. `routes.md` activates on read of any file under `apps/api/src/routes/`. `migrations.md` activates on read of migration files.

Token budget:
- Root files load always (55 + 25 + 18 = 98 lines always in context).
- Subdir files load on demand and persist for the session once loaded.
- Path-scoped rules only enter context when their matching file is read.

This pattern scales to large monorepos. Compare to a single 400-line root CLAUDE.md: same content, but the model adheres less because more competes for attention.

## Anti-examples worth seeing

The skill ships an `anti-patterns.md` reference covering specific failure modes. Briefly, what NOT to do:

**Anti-example A: bloated root CLAUDE.md.**

```markdown
# 350 lines of:
- File-by-file tours of every src directory
- Re-statement of standard JS/TS conventions
- "We aim for X" aspirations
- Long inline API docs that drift
- "Be a 10x engineer" persona instructions
- Generic platitudes ("write clean code")
```

Result: adherence drops uniformly; the model ignores everything.

**Anti-example B: globs instead of paths.**

```markdown
---
globs:
  - "src/api/**"
---
# Loads every session unconditionally because `globs:` is silently ignored.
```

Fix: use `paths:`.

**Anti-example C: personal preferences in team CLAUDE.md.**

```markdown
## My setup
- I prefer Ghostty terminal
- My sandbox is http://localhost:8080
```

Result: every teammate's PRs reference your localhost. Move to `CLAUDE.local.md`.

For the full catalog: `${CLAUDE_SKILL_DIR}/references/anti-patterns.md`.
