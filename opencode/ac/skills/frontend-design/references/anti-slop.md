<!-- ported-from: plugins/ac/skills/frontend-design/references/anti-slop.md sha256:7750dfad0311ce980711457c7144be3e7c58b8404c59633ae19ee034be85561f -->
# Distinctive output and the verification loop

Why generated UI looks the same, what actually moves it, and how to check a result by its render. Read by the implementer and by `ac/design-director`. Checked 2026-10-31 against the sources at the end.

## Contents

- Why generic instructions fail
- Patterns to rule out
- Process
- Verification loop
- Reading a tokens file
- Not established
- Sources

## Why generic instructions fail

- An instruction such as "avoid a generic AI look" swaps one default for another. Anthropic's guidance for these models says to name the specific patterns to avoid, and after the first result to check which styles it used instead and extend the list.
- Each model family has a fixed house style: Opus 4.8 defaults to a cream background (about #F4F1EA), a serif display face and a terracotta accent. "Clean and minimal" only moves it to another fixed palette.
- Two fixes work reliably (Sonnet 5 prompting guide): give a concrete alternative (hex palette, radius, typeface, hover timing), or propose four distinct visual directions, each as background hex, accent hex, typeface and a one-line rationale, and ask the user to pick one before building.
- The model's account of its own design is unreliable: in a study of 120 generated interfaces about a quarter of the stated design reasoning was not implemented. Inspect the render, not the narration.

## Patterns to rule out

Name them in the brief. The brief's own words always win: when the user asks for one of these, use it.

1. Cream background, serif display face, terracotta accent.
2. Near-black background with an acid accent.
3. Broadsheet hairlines and column rules.
4. The SaaS-card kit: identical rounded cards, one radius everywhere, the same soft `rgba(0,0,0,.1)` shadow, gradient washes.
5. Template chrome: tracked all-caps eyebrows, middle-dot meta strings, arrow glyphs on links, tinted near-black, monospace labels.
6. A single-word accent in headlines, and "01 / 02 / 03" markers on content that is not a sequence.
7. Fade-and-slide-up entrances on every section and a hover transition on every card.
8. Inter, Roboto, Arial or system-ui by reflex, and Space Grotesk as the next reflex; a purple gradient on white; emoji as icons; identical icon-topped feature cards; a badge above the H1; a stat banner.

Items 1 to 5 are the clusters in Anthropic's `frontend-design` skill (anthropics/skills at commit 41bbe19). Item 8 comes from practitioner lists and a scan of 1,590 Show HN pages where 22 percent hit four or more patterns; no per-pattern prevalence was published. Do not turn a list of acceptable typefaces into a mandate: a fixed whitelist becomes the next default.

## Process

1. Write a token plan before any code: four to six named hex values, type roles, spacing base, radius, elevation approach, motion character, and an ASCII wireframe per screen.
2. Review the plan against the brief and the patterns above; rewrite any part that matches a generic default.
3. Build from tokens only. No colour, size, radius or duration literal outside the token or theme files.
4. Screenshot, critique against the plan, fix. Stop after three rounds.

## Verification loop

Run the checks the project can run; skip, and say so, the ones it cannot.

1. `npx @google/design.md lint DESIGN.md` (exit 1 on errors). `broken-ref` is an error; `missing-typography` and `contrast-ratio` below 4.5:1 warn.
2. Grep the changed files for hex, px and ms literals outside the token files.
3. Screenshot full page at 360, 768 and 1280 px wide with the project's own browser tool (`playwright-cli` as the fallback); `page.screenshot({ fullPage: true })`. Flutter: the project's golden or device screenshot path.
4. Gates: no horizontal overflow (`document.documentElement.scrollWidth <= clientWidth` at 360); axe with `withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa'])` reports no violations; axe finds only part of the accessibility problems, so keep a manual keyboard pass.
5. Lighthouse CI once at the end (`"categories:accessibility": ["error", {"minScore": 1}]`), because it is the slowest step.
6. Add `toHaveScreenshot` regression tests only after the design is accepted. The default threshold is 0.2, animations are disabled, and rendering differs by OS, so generate baselines where they run.
7. A third-party detector (for example `npx impeccable detect`) runs unpinned registry code. Use one only when the project already depends on it, and read its findings as a reason to look closer: no accuracy figures are published.

## Reading a tokens file

The Google Labs DESIGN.md format (version alpha): YAML tokens are normative and the prose gives context. Groups are `colors`, `typography`, `rounded`, `spacing` and `components`; references look like `{colors.primary}`; dimensions use px, em or rem; sections run Overview, Colors, Typography, Layout, Elevation, Shapes, Components, Do's and Don'ts.

1. Parse the file instead of matching it with a regex, and lint it first.
2. Resolve aliases.
3. Web: emit CSS custom properties one to one from the token paths. `npx @google/design.md export --format css-tailwind|json-tailwind|dtcg` does it; there is no Flutter exporter.
4. Flutter: map to `ColorScheme`, `TextTheme` and a `ThemeExtension` (see `tokens-and-platforms.md`).
5. Read Do's and Don'ts before writing styles. For the file format itself, use the `design-md-writer` skill.

The W3C Design Tokens format (2025.10, not a W3C standard) uses `$value`, `$type` and `$description`, with colour as an object; `export --format dtcg` produces it.

## Not established

- That screenshot self-critique raises taste. The sources give process advice; no controlled measurement was found.
- That an aesthetics prompt reduces convergence across models. The evidence is qualitative.
- That "Tailwind indigo made LLM UIs purple". A plausible story from one blog, not a sourced cause.

## Sources

- Opus 5.5 prompting guide, frontend: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
- Sonnet 5 prompting guide, four directions: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5
- Anthropic frontend-design skill, pinned: https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/frontend-design/SKILL.md
- Show HN scan: https://adriankrebs.ch/blog/design-slop/; Design Theater: https://arxiv.org/abs/2607.22928
- DESIGN.md spec, pinned: https://github.com/google-labs-code/design.md/blob/6e5da5382f41edbba9d73b2c62f33f32e9971f15/docs/spec.md
- Design Tokens format: https://www.designtokens.org/tr/2025.10/format/
- Playwright: https://playwright.dev/docs/accessibility-testing, https://playwright.dev/docs/test-snapshots; Lighthouse CI: https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
