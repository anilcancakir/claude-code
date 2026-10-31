<!-- ported-from: plugins/ac/skills/frontend-design/references/stitch.md sha256:4d5ab0d44a56e0e0381519e20dbe3c339693dd63248766382d0a411bd4ba000b -->
# Stitch design-first branch (optional)

Read this only when the user asks for a design-first flow through Google Stitch and Stitch is reachable. Everything here was checked on 2026-10-31 and Stitch changes quickly; trust a live `tools/list` or `stitch --help` over this file.

## Contents

- Detect
- Surfaces
- Loop
- Guardrails
- Unverified
- Sources

## Detect

Any one of: tools named `mcp__stitch__*` are present, `STITCH_API_KEY` is set, or `stitch status` (the `@google/stitch` CLI) reports signed in. If none holds, say Stitch is not set up and continue code-first. Do not install the CLI, create a key or sign in unasked.

## Surfaces

- Hosted MCP at `https://stitch.googleapis.com/mcp`, API key in the `X-Goog-Api-Key` header or an OAuth bearer token. Fourteen tools: `create_project`, `get_project`, `list_projects`, `list_screens`, `get_screen`, `generate_screen_from_text`, `edit_screens`, `generate_variants`, `create_design_system`, `update_design_system`, `list_design_systems`, `apply_design_system`, `upload_design_md`, `create_design_system_from_design_md`.
- CLI `@google/stitch` (0.12.1 at the check date; Node 20+): `generate screen`, `get screen <id> --code`, `download screen`, `upload design DESIGN.md`, `login` or `STITCH_API_KEY` for headless use.
- TypeScript SDK `@google/stitch-sdk`. No Python SDK and no public REST reference were found.
- Stitch skill plugins, when installed (`stitch-design`, `stitch-utilities`): `stitch::generate-design`, `stitch::manage-design-system`, `stitch::extract-design-md`, `enhance-prompt`, `stitch-loop`. Call them instead of rewriting their steps.

## Loop

1. Brief: the user's request plus the direction from `ac/design-director`, or the existing `DESIGN.md`.
2. `create_project`, then import `DESIGN.md` (`upload_design_md` and `create_design_system_from_design_md`; a file larger than a few KB goes through `stitch upload design`).
3. `generate_screen_from_text` with the design system and `deviceType`. Generation takes minutes (a five-variant call took 274 s): poll `get_screen` every 30 s, up to 10 times.
4. Download the HTML and the PNG to `.stitch/designs/`. They are a reference, not the product.
5. Derive or refine `DESIGN.md` from the result and lint it (`npx @google/design.md lint`).
6. Rebuild the UI in the project's own stack from the tokens, then compare screenshots (`anti-slop.md`, verification loop).

## Guardrails

- Every mutating call (create, generate, edit, variants, upload, apply) changes the user's Stitch account and is not idempotent. Ask before the first one, and never retry a generation automatically: a retry duplicates screens.
- Do not rely on `edit_screens`. Open reports say it returns success without persisting (stitch-sdk issue 361, stitch-skills issue 68). Regenerate, or edit in the Stitch UI.
- Download URLs can redirect to a Google sign-in for API-key clients (stitch-skills issue 94, open). Use `stitch download screen`; if the HTML still fails, say so and continue from the PNG and the prompt.
- The live `get_screen` accepts only `name`, although the documentation lists more arguments (stitch-sdk issue 381).
- Two DESIGN.md dialects exist. The `design-md` utility skill writes prose-only numbered sections; `extract-design-md` writes YAML front matter that matches the Google Labs spec. Use the YAML one and lint the result.
- At most three screens or rounds per request unless the user raises the cap.

## Unverified

The current free-tier quota (no official 2026 figure), the model enum names (the documentation and the SDK manifest disagree), an agent-driven Figma export, and any REST reference.

## Sources

- Setup and tool reference: https://stitch.withgoogle.com/docs/mcp/setup/, https://stitch.withgoogle.com/docs/mcp/reference/
- CLI: https://stitch.withgoogle.com/docs/cli/overview/, https://stitch.withgoogle.com/docs/cli/design-systems/
- SDK, pinned: https://github.com/google-labs-code/stitch-sdk/blob/e3f8ece5fee46d18fa621b716bfef1fe56661b10/README.md
- Skills, pinned: https://github.com/google-labs-code/stitch-skills/blob/0337446dadde6f8c94210444e2aa9d546126480f/README.md
- DESIGN.md spec, pinned: https://github.com/google-labs-code/design.md/blob/6e5da5382f41edbba9d73b2c62f33f32e9971f15/docs/spec.md
