# Librarian Brief: Tech-Stack Research

Canonical brief shapes for `ac:librarian` invocations when the topic involves a named framework + library set (Nuxt 4 + Pinia 3 + Tailwind v4 + Vitest 3; Laravel 11 + Inertia + Vue 3; Next.js 15 + tRPC + Drizzle). The brief is split into three shapes per Stage 1d's floor 2 / target 3 librarian policy. Brief 1 and Brief 2 always spawn together; Brief 3 spawns when the librarian count reaches the target. The split is mandatory because version-combo toolchain bugs hide one-library-deep and a single bundled brief dilutes the search budget across too many angles.

## When to read this

Read in Stage 1d before spawning the librarian cohort. Spawn Brief 1 and Brief 2 as the floor (always). Add Brief 3 when 1d's target = 3 librarians or when the stack involves a second major library that briefs 1 + 2 cannot cover at one-library depth. All briefs anchor to the directory survey at `RESEARCH_DIR/00-directory-survey.md`; cite the relevant configs / version markers in the CONTEXT field.

## Brief 1: idiomatic-pattern verification (always)

```
CONTEXT: planning <topic>. Recommended stack: <list libraries with major versions>. Directory survey at RESEARCH_DIR/00-directory-survey.md identified <relevant configs and framework version markers>.
GOAL: verify the idiomatic patterns this plan will adopt against official vendor docs for the pinned versions, as of <current date>.
DOWNSTREAM: feeds the plan's Codebase Conventions section and External References list. The planner cites these doc quotes when locking pattern decisions with the user.
REQUEST:
0. Idiomatic-pattern verification: when citing an API or pattern as "idiomatic", "recommended", or "the canonical way", verify the claim against official vendor docs for the version pinned in this brief. Quote the exact line from the docs that supports each claim. Blog posts, tutorials, and forum threads are signal but not authority; the vendor docs settle semantics. For composable chains (`.X()->Y()->Z()`), test each method's effect independently in your reasoning. A chain reads idiomatic but may compose into a no-op or the opposite of the intent. Example pitfall: Laravel's `middlewareFor` ASSIGNS middleware to methods, it does not EXEMPT them; `middlewareFor(['index','show'], [])` is a no-op rather than a public-route opener, and the correct API for exemption is `withoutMiddlewareFor`. Flag any claim you cannot back with a docs quote.
1. Official setup for <stack>: initial project bootstrap, file layout, recommended config defaults. Cite official docs URLs.
2. Idiomatic patterns: how current official tutorials and examples solve the pieces this plan needs (persistence, routing, state, testing). Cite GitHub permalinks or doc URLs. Subject every pattern claim to item 0's verification clause.
Return URL/permalink citations with short code-snippet evidence. Skip toy implementations, abandoned forks, and blog-post tutorials in favor of production-quality OSS or official docs.
```

## Brief 2: known-bugs dimension (always)

```
CONTEXT: planning <topic>. Recommended stack: <list libraries with major versions>. Directory survey at RESEARCH_DIR/00-directory-survey.md identified <relevant configs and framework version markers>.
GOAL: surface toolchain pitfalls and version-combo failures for this exact stack as of <current date>. Pre-empt issues the per-library docs miss.
DOWNSTREAM: feeds the plan's Risks Accepted section (known issues without clean workarounds) and the planner's decision-tree weighting (avoid options that combine into broken toolchains).
REQUEST:
3. Known incompatibilities, deprecations, and breaking default values for the recommended stack as of <current date>. Cite GitHub issue numbers, npm deprecation notices, official upgrade-guide caveats, and forum threads from the last 12 months. Examples of what catches: a plugin that defaults to cookie storage with a 4 KB cap when the user expects localStorage; a test-utils API that broke against the current test-runner version; a CSS framework's dev-server bug in combination with another flag.
4. Toolchain bugs in the EXACT combination of versions, not just per-library. When two libraries are pinned to specific majors, search for "vitest 3 + @nuxt/test-utils 4", "Nuxt 4 + Tailwind v4 + ssr:false", "Laravel 11 + Inertia 2" style queries; the per-library docs miss combo-specific failures.
Return URL/permalink citations with short code-snippet evidence (issue snippets, reproduction steps, workaround diffs). Skip stale issues (closed > 12 months without recurrence) unless they are the canonical workaround source.
```

## Brief 3: OSS reference examples or second-library coverage (target only)

Spawn when 1d's librarian target = 3. Pick one framing per spawn based on the stack:

### Framing (a): production-quality OSS references for the specific shape

```
CONTEXT: planning <topic>. The plan introduces <specific shape: SSR-aware auth, optimistic-update mutation, streaming response handler, etc.>. Directory survey at RESEARCH_DIR/00-directory-survey.md confirms the codebase has no prior example.
GOAL: find 2 to 3 production-quality OSS implementations of <specific shape> in <stack>.
DOWNSTREAM: feeds the plan's External References. Pattern adoption is subject to Brief 1's item 0 verification clause.
REQUEST: locate production-quality OSS examples that solve <specific shape>. Each finding includes the repo, the relevant file path, a GitHub permalink anchored at the commit SHA, and a 1 to 2 line description of what makes the implementation production-quality. Skip toy implementations, examples already in docs (covered by Brief 1), and abandoned forks.
```

### Framing (b): second-library coverage when the stack exceeds Brief 1 + Brief 2

```
CONTEXT: planning <topic>. Brief 1 and Brief 2 covered <library A>; this brief covers <library B> on the same dimensions. Directory survey at RESEARCH_DIR/00-directory-survey.md identified <library B configs / version markers>.
GOAL: verify idiomatic patterns + surface known bugs for <library B> at version <X.Y> as of <current date>.
DOWNSTREAM: same as Brief 1 + Brief 2 but for <library B>.
REQUEST: run items 0-4 from the canonical brief structure (items 0-2 from Brief 1, items 3-4 from Brief 2) against <library B>. Same return format and skip rules.
```

## Why the known-bugs split is mandatory

Three real bug classes the vue-todo-app planning run hit, each preventable with this dimension:

- `@pinia-plugin-persistedstate/nuxt@1.2.1` defaults to cookies (~4 KB cap) instead of localStorage. The plan assumed localStorage; without the iter-1 fix, todos would have silently truncated after ~30-50 entries.
- `mountSuspended` from `@nuxt/test-utils/runtime` is broken in the Vitest 3 + @nuxt/test-utils@4.0.3 combo (`vitest-environment-nuxt` missing `transformMode`). Five workers independently discovered and worked around it after spawn; planning-time research would have prevented five fallback rewrites.
- Nuxt 4 dev server with `ssr: false` + Tailwind v4 vite plugin has a known startup bug ("No entry found in rollupOptions.input"). Production build works; dev is broken. The plan's `Done when: dev server starts` criterion was unsatisfiable.

Each was discoverable from public sources (GitHub issues, deprecation notices, forum threads) at the time the plan was written. Splitting Brief 2 into its own librarian keeps the search focused; bundling items 3-4 into Brief 1 dilutes the search budget across five items.

## When to skip this template

- The topic does not involve external libraries (pure internal refactor, build-config tweak with no new deps): the Stage 1d floor of 2 librarians still applies, but the briefs become generic (best-practices and pitfalls research against the language's standard library docs). The three-brief shape does not.
- The librarian is being spawned for a one-off API question, not stack-wide adoption: skip the three-brief structure; use a targeted single-question brief.
- The plan explicitly limits scope to a documented happy path with no new versions in play: spawn Brief 1 only (idiomatic-pattern verification); Brief 2 known-bugs is lower-value when no novel version combination is in play. Note this in `## Risks Accepted` so the executor knows the known-bugs angle was skipped intentionally.
