# Anti-Patterns: How CLAUDE.md and Rules Files Fail

A catalog of failure modes specific to CLAUDE.md and `.claude/rules/*.md`. Each entry: the symptom, why it happens, and the fix. Use this when auditing an existing file before shipping, or when diagnosing "Claude is not following my CLAUDE.md".

Sources: Anthropic's official docs at `https://docs.claude.com/en/docs/claude-code/memory.md` and `https://docs.claude.com/en/docs/claude-code/best-practices.md`, HumanLayer's "Writing a Good CLAUDE.md", Boris Cherny's Claude Code team tips, and community GitHub issues (anthropics/claude-code#23478, #32057, #34209, #38491, #45587).

## Contents

- Frontmatter and structure failures
- Content failures
- Scope failures
- Loading failures
- Compact / persistence failures
- Performance and token failures
- Imports failures
- Quick audit checklist

## Frontmatter and structure failures

**Using `globs:` instead of `paths:` for path-scoping.**

Symptom: rule loads at session start every session regardless of which files Claude touches. You wonder why context fills up.

Why: only `paths:` is recognized by the loader. Any other key (including `globs:`, which appears in many tutorials and old docs) is silently ignored; the rule is treated as if it had no frontmatter and loads unconditionally.

Fix: rename the frontmatter key to `paths:`. Verify by running `/memory`: if the rule appears even when no matching file has been touched, it is still unconditional.

```yaml
# Wrong - rule loads every session
---
globs:
 - "src/api/**"
---

# Right - rule loads only when matching files are read
---
paths:
 - "src/api/**"
---
```

**Setting `paths: ['**']` thinking it scopes.**

Symptom: same as above. Rule loads unconditionally despite `paths:`.

Why: the loader explicitly normalizes match-all globs to "no globs": `if (patterns.every((p: string) => p === '**')) return { content }`. The `paths:` is dropped, and the rule is treated as unconditional.

Fix: drop the `paths:` frontmatter entirely, or use a real glob (`src/**/*.ts`, `tests/**`).

**Adding frontmatter fields that the loader does not recognize.**

Symptom: `name`, `description`, `model`, `version` etc. in `.claude/rules/<topic>.md` do nothing.

Why: only `paths:` is parsed from frontmatter. Other fields are silently ignored. They are extra bytes in the file that the human sees but the loader does not process.

Fix: drop unused fields. Keep frontmatter minimal: `paths:` only when you mean path-scoping.

**Frontmatter on `CLAUDE.md` or `CLAUDE.local.md`.**

Symptom: frontmatter-shaped block at the top of CLAUDE.md is treated as content, not parsed.

Why: only `.claude/rules/*.md` has frontmatter handling in the loader. CLAUDE.md and CLAUDE.local.md are plain markdown; anything that looks like YAML at the top becomes content.

Fix: no frontmatter on CLAUDE.md / CLAUDE.local.md. Start with the canonical preface for project-team files.

## Content failures

**Aspirational rules.**

Symptom: "We aim for 90% test coverage" leads the model to write 50 trivial tests that hit coverage but add no value.

Why: the model cannot verify aspirations and follows them literally. "Aim for X" becomes "make X happen by any means available".

Fix: state what is actually enforced.

```markdown
# Aspirational - bad
- We aim for 90% test coverage.
- We strive for fast response times.
- We are moving towards full type coverage.

# Enforced - good
- CI fails if coverage drops below 80%. Run `pnpm coverage` to check.
- Type coverage is enforced by `tsc --strict` in CI. Run `npx tsc --noEmit` locally.
- (Drop performance aspirations from CLAUDE.md; track in a perf budget tool.)
```

**Vague verbs.**

Symptom: "Format properly", "handle errors", "test thoroughly". The model picks its own interpretation, which may not match yours.

Why: the model needs concrete, verifiable rules. Vague verbs allow the model to do anything and call it "proper".

Fix: replace with specific, checkable instructions.

```markdown
# Bad
- Write good error handling.

# Good
- Catch specific exceptions, not bare `Exception`. Log operation, args, user ID. Return typed error response with status code.
```

**Negative-only instructions.**

Symptom: "Don't use `any`" leads the model to look for any non-`any` alternative, including overly permissive types.

Why: the model needs the positive alternative.

Fix: "Don't X. Do Y instead."

```markdown
# Bad
- Don't use `any` in TypeScript.

# Good
- Don't use `any`. Use `unknown` and narrow with type guards or assertions.
```

**Generic platitudes.**

Symptom: "Write clean code", "follow best practices", "consider edge cases" produce nothing. The model has stronger priors than these.

Why: these are unverifiable and the model already knows them. Pure tax on the attention budget.

Fix: cut. If a specific practice matters, write a specific rule. Otherwise let the model use its priors.

**Standard language conventions.**

Symptom: "Python uses snake_case", "JavaScript uses camelCase", "use semicolons in JS". The model already follows these without being told.

Why: the model has strong priors on language defaults. Restating them is pure tax.

Fix: cut. Mention only conventions that DIFFER from the default.

```markdown
# Bad - default behavior
- Use camelCase for JavaScript variables.

# Good - differs from default
- Use camelCase for JS variables, snake_case for JSON keys (API contract). Convert between with `humps`.
```

**File-by-file tours.**

Symptom: "`src/index.ts` is the entry point", "`src/routes/users.ts` handles users", etc. Lists every file.

Why: the model reads files. It does not need a tour. Lines that describe what the agent can discover are pure tax.

Fix: list directories ONLY when their meaning is non-obvious.

```markdown
# Bad - the agent reads these
- `src/index.ts` - entry point
- `src/routes/users.ts` - user routes
- `src/utils/format.ts` - formatting helpers

# Good - non-obvious meaning
- `src/jobs/` - runs in a separate worker process via BullMQ
- `src/lib/` - server-only; do not import from client components
- `apps/web/` - Next.js app; `apps/api/` - standalone Express API
```

**Long API documentation inlined.**

Symptom: 200 lines of route schemas in CLAUDE.md that drift from the actual API.

Why: API docs change faster than CLAUDE.md. Inline copies go stale silently. The model gets stale context.

Fix: pitch on demand, or `@import`.

```markdown
# Bad - inline drifts
## API Reference
### POST /users
Body: { name, email, password }
[200 more lines]

# Good - pitch
- For the API reference, read `docs/api-reference.md`.

# Acceptable - inline if it never drifts
@docs/api-contract.md
```

**Credentials, secrets, sensitive data.**

Symptom: API key, internal URL, or customer data in CLAUDE.md. The file is committed; everyone with repo access can see it.

Why: CLAUDE.md is code. Treat it like code.

Fix: never include secrets. Put per-developer credentials in `CLAUDE.local.md` if they MUST be in a file, and even there only stuff that is not actually sensitive (sandbox URLs, dev tokens with no production access). Use environment variables or a secret manager for real secrets.

**Personality and persona instructions.**

Symptom: "Be a senior engineer", "Think step by step", "Respond as a 10x developer". Wastes tokens and confuses the model.

Why: Claude Code already has strong system-level instructions. Persona overlays interfere rather than help.

Fix: cut. The model already has a strong "professional assistant" persona. Add behavioral rules ("be terse", "explain tradeoffs") to user-global memory if they apply across all projects.

**The agent already knows about commands.**

Symptom: standard commands listed in CLAUDE.md when `package.json` has them.

```markdown
# Bad - standard, in package.json
- Run tests: `npm test`
- Install: `npm install`
- Lint: `npm run lint`
```

Why: the agent reads manifest files. Standard commands are discoverable; the lines are tax.

Fix: list ONLY non-standard commands.

```markdown
# Good - non-standard
- Run a single test: `pytest -k 'test_name' -xvs`
- Migrate the dev database: `pnpm db:migrate:dev` (wrapper that seeds test data)
- Run typecheck without emit: `npx tsc --noEmit`
```

## Scope failures

**Team rules in user-global memory.**

Symptom: rule applies to you but teammates do not see it. "Consistency" breaks subtly across the team.

Why: `~/.claude/CLAUDE.md` is yours alone. Teammates have their own.

Fix: move team-shared rules to `./CLAUDE.md`. Commit. Run `/memory` to verify the project loads the file.

**Personal config in team CLAUDE.md.**

Symptom: your sandbox URL appears in PR diffs; teammates' Claude sessions use your test account.

Why: anything in `./CLAUDE.md` is team-shared via git.

Fix: move to `./CLAUDE.local.md`. Add to `.gitignore`.

**Compliance rules in project CLAUDE.md.**

Symptom: an org-wide compliance rule keeps getting removed or weakened in PRs.

Why: project CLAUDE.md is editable per-project. Engineers prune what they think is verbose.

Fix: deploy via managed policy (`/etc/claude-code/CLAUDE.md` or platform equivalent) so the rule cannot be excluded.

**Duplicate rules across scopes.**

Symptom: same rule in `~/.claude/CLAUDE.md` AND `./CLAUDE.md`. Wastes attention budget; if they ever diverge, the project rule wins.

Why: copy-paste. Or rule moved between scopes without removing the original.

Fix: each rule lives in exactly one scope. Run `/memory`, scan for duplication.

## Loading failures

**File at wrong path.**

Symptom: rule written, `/memory` does not list the file.

Possible paths:

- User rules: must be `~/.claude/rules/`, NOT `~/.claude/.claude/rules/`. One level shallower than project rules.
- Project rules: must be `<dir>/.claude/rules/`, NOT `<dir>/rules/`.
- Local: `<dir>/CLAUDE.local.md` at the project root.
- Project CLAUDE.md: `<dir>/CLAUDE.md` OR `<dir>/.claude/CLAUDE.md`. Both are read.

Fix: move the file. Run `/memory` to confirm it loaded.

**Wrong filename case.**

Symptom: `claude.md` or `CLAUDE.MD` does not load.

Why: the loader looks for the exact basename `CLAUDE.md` (case-sensitive on Linux). On macOS the filesystem may be case-insensitive but the runtime uses the canonical name.

Fix: rename to exactly `CLAUDE.md`.

**Settings-source disabled.**

Symptom: file is on disk but `/memory` does not show it. Other CLAUDE.md files load fine.

Why: `--setting-sources` flag may exclude `user`, `project`, or `local` settings (and corresponding CLAUDE.md files). Or `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` is set.

Fix: check the launch command and env. Without `--setting-sources`, all three sources are enabled by default.

**`claudeMdExcludes` filtering it.**

Symptom: file exists, path is right, but it does not load.

Why: a glob in `claudeMdExcludes` (any layer: user / project / local / managed) matches the path.

Fix: check `.claude/settings.local.json`, `.claude/settings.json`, and `~/.claude/settings.json` for `claudeMdExcludes`. Run `/doctor` (or check the `tengu_claudemd__initial_load` analytics event in the debug log) to see the exclusion.

**Path-scoped rule not firing.**

Symptom: `paths:` is set correctly, but the rule does not appear in context.

Causes:

- The glob does not match the file Claude touched. Test the glob mentally.
- Claude used Write/Edit/MultiEdit without first reading the file. Only Read triggers path-scoped rules.
- The rule is also loaded unconditionally elsewhere (a duplicate without `paths:`).
- The frontmatter key is `globs:` not `paths:` (unconditional load).

Fix per cause: tighten or loosen the glob; ensure Claude reads the file first (instruct it to in CLAUDE.md if needed); deduplicate; rename `globs:` to `paths:`.

## Compact / persistence failures

**Rule disappears after `/compact`.**

Symptom: the rule was working, then `/compact` ran, and Claude stopped following it.

Why: the rule is in a SUBDIRECTORY CLAUDE.md or a `paths:`-scoped rule file. These live in the message stream (lazy-loaded as attachments), and compact summarizes them away.

Fix: if the rule must persist, move it to project-root CLAUDE.md (eagerly loaded into the cached `<system-reminder>` user message, re-read from disk after compact). Or accept that the next file touch will reload it.

**Instructions typed in conversation do not survive compact.**

Symptom: "I told Claude to use 4-space indent earlier, but after compact it switched back."

Why: in-conversation instructions are part of the conversation, summarized away by compact.

Fix: add to CLAUDE.md. The runtime re-reads CLAUDE.md after compact and re-injects it.

## Performance and token failures

**Too many rule files.**

Symptom: context window fills up faster than expected. Long sessions truncate or compact prematurely.

Why: each loaded `.claude/rules/*.md` file (especially conditional ones with `paths:`) sits in conversation context after loading. Community-reported math: 11 rule files (~6,200 tokens) consumed ~93K tokens across a 30-tool-call session.

Fix: consolidate to 3-5 rule files. Each under 30 lines. Use `paths:` aggressively so rules do not load on sessions that do not need them.

**Rule files too long.**

Symptom: a single rule file is 100+ lines. It is hard to maintain and the model's adherence to specific rules drops.

Why: long rule files dilute attention. The model sees a wall of text and prioritizes loosely.

Fix: split. If a topic feels like 100 lines, it is probably two topics. Identify the natural split (e.g., `api-routes.md` + `api-errors.md`) and break.

**Cloudflare-sized CLAUDE.md.**

Symptom: 230+ line CLAUDE.md. Adherence drops uniformly. The model ignores rules you care about.

Why: Anthropic's docs target under 200 lines per file. Community benchmarks (HumanLayer 57, ChrisWiles 80, Boris Cherny ~83) put the sweet spot at 40-80.

Fix: run the cut/move pass. Move topic-specific content to `.claude/rules/<topic>.md`. Move long reference content to `@imports`. Move multi-step procedures to skills. Remove anything that fails the "would Claude make a mistake without this?" test.

## Imports failures

**Recursive import depth exceeded.**

Symptom: an imported file's `@path` does not resolve. No error; the file is silently skipped.

Why: `MAX_INCLUDE_DEPTH = 5` Beyond 5 hops, the loader stops.

Fix: flatten the import graph. Two-level (CLAUDE.md imports one file) is the sweet spot. Five-level chains work technically but are a maintenance smell.

**External-import approval dialog blocks repo onboarding.**

Symptom: every new developer cloning the repo sees an approval dialog the first time they run Claude Code.

Why: `./CLAUDE.md` imports a path outside cwd (e.g., `@~/.claude/personal.md` or `@/etc/shared.md`). The runtime requires per-project approval.

Fix: for project-team files, keep imports within the project tree. If you need to share content from `~/.claude/`, put it in `CLAUDE.local.md` (which is gitignored, so each dev has their own and the approval only affects their machine).

**`@docs/api.md` loads every session even when the API is not the topic.**

Symptom: long imported file inflates every session's context.

Why: `@imports` load at session start, regardless of whether the content is relevant this session.

Fix: pitch instead. Replace `@docs/api.md` with "For API conventions, read." The model uses Read on demand; the file only enters context when needed.

**`@` inside fenced code blocks accidentally documented as live syntax.**

Symptom: example `@path` in a code fence works as intended (no expansion), but a teammate reading the file thinks expansion happens.

Why:, code blocks and codespans are skipped. The example in the fence is documentation, not a real import.

Fix: explicit text labels. "Example: `@./docs/api.md` (inside code, NOT expanded). Outside code: @./docs/api.md (expanded)."

## Quick audit checklist

Before shipping a CLAUDE.md or rule file, walk this:

**Frontmatter:**
- [ ] CLAUDE.md / CLAUDE.local.md: NO frontmatter.
- [ ] Rule file: only `paths:` (if path-scoping). No `globs:`, no `name:`, no other fields.
- [ ] Path-scoping: `paths:` is set if scoping is desired; not `paths: ['**']` (no-op).

**Scope:**
- [ ] File at the correct path. User: `~/.claude/{CLAUDE.md, rules/}`. Project: `<dir>/{CLAUDE.md.claude/CLAUDE.md.claude/rules/}`. Local: `<dir>/CLAUDE.local.md`.
- [ ] Team-shared rules in project CLAUDE.md (committed). Personal rules in `~/.claude/CLAUDE.md` or `CLAUDE.local.md` (not committed).
- [ ] `CLAUDE.local.md` is in `.gitignore`.
- [ ] No org-wide compliance content in project CLAUDE.md (use managed policy).

**Length:**
- [ ] CLAUDE.md under 200 lines (target under 80 if possible).
- [ ] Each rule file under 30 lines.
- [ ] Total rule-file count 3-5 max.

**Content:**
- [ ] Every line passes the "would removing this cause Claude to make mistakes?" test.
- [ ] No aspirations ("we aim for X").
- [ ] No vague verbs (use specific, verifiable rules).
- [ ] No negative-only rules (every "don't" has a "do" alternative).
- [ ] No generic platitudes ("write clean code").
- [ ] No standard-language conventions.
- [ ] No file-by-file tours.
- [ ] No long API documentation inlined; pitch instead.
- [ ] No credentials or secrets.
- [ ] No personality/persona instructions.
- [ ] No standard commands available from manifest files.
- [ ] Emphasis keywords (`IMPORTANT:`, `YOU MUST`, `NEVER`) reserved for 2-3 rules max.

**Imports:**
- [ ] `@imports` only for content needed every session.
- [ ] Optional content uses pitches ("For X, read `path`").
- [ ] No imports that escape the project tree without approval (or accept the approval friction).
- [ ] Import graph depth no greater than 2.

**Loading verification:**
- [ ] Run `/memory`: the file appears in the loaded list with the expected scope.
- [ ] For path-scoped rules: read a matching file in a test session; verify the rule appears in the message stream after the read.
- [ ] For canonical preface: project-team `./CLAUDE.md` starts with `# CLAUDE.md\n\nThis file provides guidance to Claude Code.`.

**Behavior:**
- [ ] Project-team file does NOT contain personal preferences.
- [ ] Project-personal file does NOT contain team-shared rules.
- [ ] After a representative session, the model follows the rule. If not, the rule is vague, conflicting with another file, or oversized. See `loader-and-injection.md` troubleshooting.

If all boxes check, the file is ready to ship. If any fail, fix before commit.
