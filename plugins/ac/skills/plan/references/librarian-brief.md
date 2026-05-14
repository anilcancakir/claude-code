# Librarian Brief: Tech-Stack Research

Canonical brief shape for `ac:librarian` invocations when the topic involves a named framework + library set (e.g., "Nuxt 4 + Pinia 3 + Tailwind v4 + Vitest 3", "Laravel 11 + Inertia + Vue 3", "Next.js 15 + tRPC + Drizzle"). The known-bugs research dimension is mandatory for tech-stack briefs; it pre-empts toolchain pitfalls the planner would otherwise hit at execute time.

## When to read this

Read in Stage 1c whenever you are about to spawn an `ac:librarian` for tech-stack research. The known-bugs dimension is in ADDITION to your topic-specific question, not a replacement; combine both in the REQUEST field.

## Brief shape

```
CONTEXT: planning <topic>. Recommended stack: <list libraries with major versions>.
GOAL: ground the plan in current best practices AND surface toolchain pitfalls for this exact stack as of <current date>.
DOWNSTREAM: feeds the plan's Codebase Conventions section, External References list, and the Risks Accepted section (for known issues without clean workarounds).
REQUEST:
0. Idiomatic-pattern verification: when citing an API or pattern as "idiomatic", "recommended", or "the canonical way", verify the claim against official vendor docs for the version pinned in this brief. Quote the exact line from the docs that supports each claim. Blog posts, tutorials, and forum threads are signal but not authority; the vendor docs settle semantics. For composable chains (`.X()->Y()->Z()`), test each method's effect independently in your reasoning — a chain reads idiomatic but may compose into a no-op or the opposite of the intent. Example pitfall: Laravel's `middlewareFor` ASSIGNS middleware to methods, it does not EXEMPT them; `middlewareFor(['index','show'], [])` is a no-op rather than a public-route opener, and the correct API for exemption is `withoutMiddlewareFor`. Flag any claim you cannot back with a docs quote.
1. Official setup for <stack>: initial project bootstrap, file layout, recommended config defaults. Cite official docs URLs.
2. Idiomatic patterns: how current official tutorials and examples solve the pieces this plan needs (e.g., persistence, routing, state, testing). Cite GitHub permalinks or doc URLs. Subject every pattern claim to item 0's verification clause.
3. Known incompatibilities, deprecations, and breaking default values for the recommended stack as of <current date>. Cite GitHub issue numbers, npm deprecation notices, official upgrade-guide caveats, and forum threads from the last 12 months. Examples of what catches: a plugin that defaults to cookie storage with a 4 KB cap when the user expects localStorage; a test-utils API that broke against the current test-runner version; a CSS framework's dev-server bug in combination with another flag.
4. Toolchain bugs in the EXACT combination of versions (not just per-library). When two libraries are pinned to specific majors, search for "vitest 3 + @nuxt/test-utils 4", "Nuxt 4 + Tailwind v4 + ssr:false", "Laravel 11 + Inertia 2" style queries; the per-library docs miss combo-specific failures.
Return URL/permalink citations with short code-snippet evidence. Skip toy implementations, abandoned forks, and blog-post tutorials in favor of production-quality OSS or official docs.
```

## Why the known-bugs dimension is mandatory

Three real bug classes the vue-todo-app planning run hit, each preventable with this dimension:

- `@pinia-plugin-persistedstate/nuxt@1.2.1` defaults to cookies (~4 KB cap) instead of localStorage. The plan assumed localStorage; without the iter-1 fix, todos would have silently truncated after ~30-50 entries.
- `mountSuspended` from `@nuxt/test-utils/runtime` is broken in the Vitest 3 + @nuxt/test-utils@4.0.3 combo (`vitest-environment-nuxt` missing `transformMode`). Five workers independently discovered and worked around it after spawn; planning-time research would have prevented five fallback rewrites.
- Nuxt 4 dev server with `ssr: false` + Tailwind v4 vite plugin has a known startup bug ("No entry found in rollupOptions.input"). Production build works; dev is broken. The plan's `Done when: dev server starts` criterion was unsatisfiable.

Each was discoverable from public sources (GitHub issues, deprecation notices, forum threads) at the time the plan was written. Adding the known-bugs dimension to every tech-stack librarian brief raises the planning-time catch rate without raising token cost meaningfully (the librarian search is parallel with the topic-specific question).

## When to skip this template

- The topic does not involve external libraries (pure internal refactor, build-config tweak with no new deps): skip; use the generic `<brief_shape>` in SKILL.md Stage 1c instead.
- The librarian is being spawned for a one-off API question, not stack-wide adoption: skip; use a targeted single-question brief.
- The plan explicitly limits scope to a documented happy path with no new versions in play: skip; the known-bugs dimension is for novel combinations.
