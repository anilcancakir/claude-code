# Stitch design-first branch (optional)

Read this only when the user asks for a design-first flow through Google Stitch and Stitch is reachable. Everything here was checked on 2026-11-01 and Stitch changes quickly; trust a live `tools/list` or `stitch --help` over this file.

## Contents

- Detect
- Surfaces
- The prompt
- Loop
- Hand-off to code
- Guardrails
- Unverified
- Sources

## Detect

Any one of: tools named `mcp__stitch__*` are present, `STITCH_API_KEY` is set, or `stitch status` (the `@google/stitch` CLI) reports signed in. If none holds, say Stitch is not set up and continue code-first. Do not install the CLI, create a key or sign in unasked.

## Surfaces

- Hosted MCP at `https://stitch.googleapis.com/mcp`, API key in the `X-Goog-Api-Key` header or an OAuth bearer token (about an hour). Fourteen tools: `create_project`, `get_project`, `list_projects`, `list_screens`, `get_screen`, `generate_screen_from_text`, `edit_screens`, `generate_variants`, `create_design_system`, `update_design_system`, `list_design_systems`, `apply_design_system`, `upload_design_md`, `create_design_system_from_design_md`.
- `generate_screen_from_text(projectId, prompt, deviceType?, modelId?)`: `deviceType` is `MOBILE`, `DESKTOP`, `TABLET` or `AGNOSTIC`; the MCP reference lists `modelId` as `GEMINI_3_FLASH` and `GEMINI_3_1_PRO` (`GEMINI_3_PRO` deprecated), while the SDK README lists other names, so read the live schema.
- `generate_variants` takes a count of 1 to 5, a `creativeRange` (`REFINE`, `EXPLORE`, `REIMAGINE`) and `aspects` (`LAYOUT`, `COLOR_SCHEME`, `IMAGES`, `TEXT_FONT`, `TEXT_CONTENT`).
- A design system is a `DesignTheme`: colour mode, headline and body font from a closed list of 29 (Inter, Geist, DM Sans and others), roundness and a seed colour. A typeface outside that list cannot be applied inside Stitch through this API; expect a substitute in the Stitch render and the real typeface in the rebuild (inferred from the closed list and the free-form `designMd` field; not tested).
- CLI `@google/stitch` (0.12.1 at the 2026-10-31 check; Node 20+): `generate screen`, `edit screen`, `generate variants`, `get screen <id> --code --output f.html`, `upload design DESIGN.md`, `login` or `STITCH_API_KEY` for headless use. `stitch agent-skills add --user` installs Stitch's own `/stitch` skill (documented, not run here).
- TypeScript SDK `@google/stitch-sdk`. No Python SDK and no public REST reference were found.
- Official Stitch skills (`google-labs-code/stitch-skills`; install per its README), when present: `stitch-design` (`generate-design`, `manage-design-system`, `extract-design-md`, `code-to-design`, `extract-static-html`, `upload-to-stitch`), `stitch-utilities` (`enhance-prompt`, `design-md`, `stitch-loop`, `taste-design`, `site-md`) and `stitch-build` (`react-components`, `react-native`, `react-vite-dashboard`, `shadcn-ui`, `remotion`). Call them instead of rewriting their steps; the prompt shape below follows their rules.

## The prompt

What Stitch's own guidance says: the first prompt is an Idea, a Theme and the Content, and "Don't worry about specific font selections or hex codes yet"; work on one screen and "make one major change at a time"; use UI and UX keywords and reference elements specifically; to move to another device, translate rather than resize by describing the changed navigation, hero and grid density. Without a bound DESIGN.md "colors, fonts, and spacing will drift from one screen to the next". Users report that a very long prompt (over about 5,000 characters) makes Stitch drop components, and that an edit asking for several changes rebuilds the layout.

The shape below is this plugin's synthesis of those rules and of `generate-design` and `enhance-prompt`; the reconciliation of the two on hex values is an inference, not a Stitch statement. `ac:design-director` writes the block at the end of its `commit` output when the brief says the build goes through Stitch; fill the content from the real brief.

Generation, with the DESIGN.md imported and applied as the design system:

```text
[Idea: one sentence naming the product, this screen, who uses it and the job it does.]

PLATFORM: [Mobile portrait | Desktop 1280 | Tablet]
PAGE STRUCTURE:
1. [Region, in UI vocabulary: top app bar, hero, data table, bottom sheet]: [what it holds, with real copy in quotes]
2. [Region]: [content, and the state it shows]
VIBE: [two or three plain adjectives taken from the DESIGN.md overview]
EXCLUDE: [what must not appear, for example "no stat banner, no eyebrow labels"]
```

- No hex values, font names or radius values: the bound design system supplies them, and `generate-design` forbids them in a generation prompt once one exists.
- With no design system bound, prefer to bind one first (`upload_design_md`, then `create_design_system_from_design_md`). If you cannot, add a `DESIGN SYSTEM (REQUIRED):` block of `Descriptive name (#hex) for the functional role` lines, the typefaces and the radius, copied from DESIGN.md or the director's direction.
- Real copy, not lorem ipsum. Describe what the screen shows, not how it is built, and name the empty, loading or error state when the screen is that state.
- One screen per call, kept under about 3,000 characters (a heuristic, below the user reports).
- Edit: one change, the element named, the rest protected. "On the berth card, replace the caption with the tide window. Keep everything else unchanged." A hex value is acceptable in an edit.
- Another device is a new generation from the same structure with the navigation, hero and density changes written out.

## Loop

1. Brief: the user's request plus the direction from `ac:design-director`, or the existing `DESIGN.md`.
2. Ask before the first mutating call (see Guardrails).
3. `create_project`, then import `DESIGN.md` (`upload_design_md` and `create_design_system_from_design_md`; a file larger than a few KB goes through `stitch upload design`). `apply_design_system` needs the screen instance `id` from `get_project`, not the source screen id.
4. `generate_screen_from_text` with the prompt above and `deviceType`. Generation takes minutes (a five-variant call took 274 s): poll `get_screen` every 30 s, up to 10 times, and do not retry on a connection error.
5. Look at the screenshot, then refine one change per call, or regenerate with the amended prompt when `edit_screens` does not persist.
6. Download the HTML and the PNG to `.stitch/designs/`. They are a reference, not the product.
7. Derive or refine `DESIGN.md` from the result and lint it (`npx @google/design.md@0.4.0 lint DESIGN.md`).

## Hand-off to code

Stitch's HTML is "a base for translation": a model rebuilds it, with the screenshot beside it, in the project's own stack. Take the tokens from DESIGN.md, not from the Tailwind config inlined in the HTML head, unless no DESIGN.md exists. Rebuild with the project's components and the platform rules in `tokens-and-platforms.md`. Stitch designs the happy path, so add the loading, empty, error and success states yourself. Then run the verification loop in `anti-slop.md` and compare the render with the Stitch screenshot at 360, 768 and 1280 px.

## Guardrails

- Every mutating call (create, generate, edit, variants, upload, apply) changes the user's Stitch account and is not idempotent. Ask before the first one, and never retry a generation automatically: a retry duplicates screens.
- Do not rely on `edit_screens`. Open reports say it returns success without persisting (stitch-sdk issue 361, stitch-skills issue 68), as checked on 2026-10-31. Regenerate, or edit in the Stitch UI.
- Download URLs can redirect to a Google sign-in for API-key clients (stitch-skills issue 94, open). Use `stitch download screen`; if the HTML still fails, say so and continue from the PNG and the prompt.
- The live `get_screen` accepted only `name` at the 2026-10-31 check, although the documentation lists `projectId` and `screenId` as well (stitch-sdk issue 381). Read the live schema.
- Two DESIGN.md dialects exist. The `design-md` utility skill writes prose-only numbered sections; `extract-design-md` writes YAML front matter that matches the Google Labs spec. Use the YAML one and lint the result.
- At most three screens or rounds per request unless the user raises the cap.
- Never print an API key or put one in a file. The `claude mcp add` line with the key is the user's to run.

## Unverified

The free-tier quota (a third-party snippet claims 350 standard and 50 thinking generations a month; no official figure), which model enum is current, an agent-driven Figma export, whether the Design Modes docs page still matches the product, and any REST reference.

## Sources

- Prompting and concepts: https://stitch.withgoogle.com/docs/learn/overview, https://stitch.withgoogle.com/docs/learn/prompting/, https://stitch.withgoogle.com/docs/learn/device-types/, https://stitch.withgoogle.com/llms.txt
- Setup and tool reference: https://stitch.withgoogle.com/docs/mcp/setup/, https://stitch.withgoogle.com/docs/mcp/reference/
- CLI: https://stitch.withgoogle.com/docs/cli/overview/, https://stitch.withgoogle.com/docs/cli/design-systems/, https://stitch.withgoogle.com/docs/cli/agent-bridge/
- Stitch prompt guide thread and user reports (forum): https://discuss.ai.google.dev/t/stitch-prompt-guide/83844
- SDK, pinned: https://github.com/google-labs-code/stitch-sdk/blob/e3f8ece5fee46d18fa621b716bfef1fe56661b10/README.md
- Skills, pinned: https://github.com/google-labs-code/stitch-skills/blob/0337446dadde6f8c94210444e2aa9d546126480f/README.md
- DESIGN.md spec, pinned: https://github.com/google-labs-code/design.md/blob/6e5da5382f41edbba9d73b2c62f33f32e9971f15/docs/spec.md
