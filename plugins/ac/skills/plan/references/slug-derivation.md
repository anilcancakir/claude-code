# Slug Derivation

The full algorithm behind Stage 0b, plus worked examples. Read this at Stage 0b; the skill body carries only the summary and the outputs.

It lives here rather than in the body because it is needed exactly once, at the start of a run, and a re-attached skill keeps only its first 5,000 tokens after compaction (https://code.claude.com/docs/en/skills.md). Procedure used once early belongs in a reference; the rules that must hold all run belong in the body.

## The seven steps, in order

1. **Absolute-path prefix strip**: if the topic STARTS with an absolute path (matches `^/[^ ]+/[^ ]*`), separate the path prefix from the trailing topic body. Store the path as `PROJECT_DIR_HINT` (used as the Recommended default for the Stage 3 D1 project-location decision when one fires). The trailing body becomes the slug-derivation input.
2. **Tokenize**: split slug-input on whitespace into raw tokens. Preserve original casing for the final normalize step; transformations in steps 3-5 operate on derived forms without mutating the original token strings.
3. **Diacritic-normalize for matching** (Turkish ASCII fold): produce a `normalized form` of each token by applying the fold `ı→i, İ→I, ş→s, Ş→S, ç→c, Ç→C, ö→o, Ö→O, ü→u, Ü→U, ğ→g, Ğ→G` and lowercasing. Use this `normalized form` for stopword and tech-stack matching in steps 4-5. The `normalized form` is matching-only; the original casing is preserved for step 7. The ASCII fold makes `altinda` (user-typed) and `altında` (Turkish keyboard) match the same stopword entry.
4. **Stopword filter** (case-insensitive AND diacritic-insensitive; drop any token whose `normalized form` matches an entry below):
   - TR: `ile, bir, bu, su, icin, gibi, kadar, cok, az, ya, ve, veya, altinda, ustunde, uzerinde, icinde, disinda, ki, mi, mu, olarak, calisak, calismak, yapalim, yapmak, kuralim, kurmak, gelistirelim, gelistirme, projesi, proje, uygulamasi, uygulama, sistemi, sistem`
   - EN: `the, a, an, of, to, in, on, at, with, by, for, from, and, or, but, as, is, are, was, were, be`

   List entries are in ASCII-fold plus lowercase form; the token's `normalized form` from step 3 matches against this list.
5. **Tech-stack token preference**: scan the surviving tokens for matches against this regex (case-insensitive on `normalized form`):

   `^(laravel|vue|nuxt|react|svelte|astro|next|jetstream|livewire|inertia|django|flask|rails|spring|express|hono|trpc|graphql|grpc|kafka|redis|postgres|postgresql|mysql|mongodb|sqlite|tailwind|prisma|drizzle|vitest|jest|pest|bun|node|nodejs|deno|typescript|javascript|python|golang|rust|kotlin|swift|flutter|html|markdown|md|mcp|cli|api|server|db|cache|webhook|websocket|sdk)$`

   If at least one token matches, the truncate step prioritizes tech-stack matches into the first-5 slots (up to 5 if many), then fills the remaining slots with non-tech surviving tokens in their original order. When zero tech-stack matches, truncate proceeds with original order.
6. **Truncate**: take the first 5 tokens per the priority order from step 5 (tech-stack matches first, then non-tech fill).
7. **Normalize**: lowercase each truncated token (original casing form, NOT the diacritic-folded form), replace any run of non-alphanumeric characters within each token with a single hyphen, join with `-`, then collapse any run of consecutive `-` in the joined string to a single `-`, finally strip leading and trailing hyphens.

## Empty-slug fallback

If the resulting slug is empty (every token was a stopword, a pathological case), fall back to the topic's first non-stopword word. If even that fails, use `unnamed-plan` and surface the unusual slug in Stage 3a so the user can override it.

## Worked examples

- `"Add Health-Check Endpoint v2"` → no path-strip; no diacritic; no stopword drop; tech matches none → tokens `["Add", "Health-Check", "Endpoint", "v2"]` → truncate 5 → normalize → `add-health-check-endpoint-v2`.
- `"nodejs typescript ile local bir mcp server kuralim"` → no path-strip; diacritic-norm noop; drop `ile`, `bir`, `kuralim` → survivors `["nodejs", "typescript", "local", "mcp", "server"]`; tech matches `[nodejs, typescript, mcp, server]` → truncate-5 priority `[nodejs, typescript, mcp, server, local]` → `nodejs-typescript-mcp-server-local`.
- `"/Users/anil/Code/foo/references altinda laravel jetstream blog"` → path-strip → `PROJECT_DIR_HINT = "/Users/anil/Code/foo/references/"`, slug-input `"altinda laravel jetstream blog"`; diacritic-norm `altinda` already ASCII; drop `altinda` → survivors `[laravel, jetstream, blog]`; tech matches `[laravel, jetstream]` → truncate-5 priority `[laravel, jetstream, blog]` → `laravel-jetstream-blog`.
- `"/Users/anil/Code/foo/references altinda nodejs + typescript ile cli olarak calisak html to markdown projesi"` → path-strip; diacritic-norm noop (input already ASCII); drop `altinda, ile, olarak, calisak, to, projesi` → survivors `[nodejs, +, typescript, cli, html, markdown]`; tech matches `[nodejs, typescript, cli, html, markdown]` (5 tech) → truncate-5 `[nodejs, typescript, cli, html, markdown]` → normalize step 7 (`+` token replaced, then post-join collapse) → `nodejs-typescript-cli-html-markdown`. Tech-stack priority preempts `+` from surviving into the slug.
- `"the the the foo bar"` → drop `the` three times → tokens `[foo, bar]`; no tech matches → `foo-bar`.
