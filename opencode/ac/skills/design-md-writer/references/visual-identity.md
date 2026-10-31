<!-- ported-from: plugins/ac/skills/design-md-writer/references/visual-identity.md sha256:8b4136ac62504ed731bc9677e78250bbc03f5c8e7f60979325869194cd9b5a73 -->
# Visual identity DESIGN.md

Google Labs publishes DESIGN.md as a format for describing a visual identity to coding agents: machine-readable tokens plus prose rationale. This page condenses its README (`https://github.com/google-labs-code/design.md`, read 2026-10-30). The format declares itself alpha and warns to expect changes, and the full `docs/spec.md` was not read, so re-check the README before relying on a detail.

## Contents

- When to use it
- File structure
- Token schema
- Section order
- Authoring for agents
- Tooling

## When to use it

Use it when a project has a UI and the user wants a brand or style spec agents can follow. For layout and component implementation work, use a frontend skill if one is installed, after the file exists. It does not replace an architecture doc; see the naming rule in the skill body.

## File structure

Two layers. YAML tokens come first, either between `---` fences at the top or as fenced `yaml` blocks inside each section. Markdown follows, in `##` sections. The tokens are the normative values; the prose says why they exist and how to apply them.

```markdown
---
name: Heritage
colors:
  primary: "#1A1C1E"
  tertiary: "#B8422E"
typography:
  body-md:
    fontFamily: Public Sans
    fontSize: 1rem
rounded:
  sm: 4px
spacing:
  md: 16px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    rounded: "{rounded.sm}"
---

## Overview

[Brand character in two or three sentences.]

## Colors

- **Primary (#1A1C1E):** [role of the color]
```

## Token schema

Top-level keys: `version` (optional, currently `alpha`), `name`, `description` (optional), `colors`, `typography`, `rounded`, `spacing`, `components`, and `omitted` (sections left out on purpose).

| Type | Format | Example |
|---|---|---|
| Color | Any CSS color | `"#1A1C1E"`, `"oklch(62% 0.18 250)"` |
| Dimension | Number plus `px`, `em` or `rem` | `48px`, `-0.02em` |
| Token reference | `{path.to.token}` | `{colors.primary}` |
| Typography | Object: `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `fontFeature`, `fontVariation` | see above |

Component properties: `backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, `width`. A variant such as hover or pressed is its own entry with a related name (`button-primary-hover`).

## Section order

Sections may be omitted; those present appear in this order: Overview (alias Brand & Style), Colors, Typography, Layout (alias Layout & Spacing), Elevation & Depth (alias Elevation), Shapes, Components, Do's and Don'ts.

Consumers preserve an unknown section heading and accept unknown token names with valid values. A duplicate section heading or a duplicate top-level YAML key is an error.

## Authoring for agents

- Put exact values in tokens and the reason in prose. A token without a role sentence gets used arbitrarily; a role sentence without a token gets approximated.
- Give each color one role ("the sole driver for interaction"), not a mood.
- Write Do's and Don'ts as concrete, checkable rules ("one tertiary button per view").
- Reference tokens with `{path}` inside components instead of repeating hex values.
- Derive tokens from the existing stylesheet or theme file when one exists, and verify against it. Ask the user only for brand intent the code cannot show.

## Tooling

```bash
npx @google/design.md lint DESIGN.md
npx @google/design.md diff DESIGN.md DESIGN-v2.md
npx @google/design.md export --format css-tailwind DESIGN.md > theme.css
```

`lint` returns structured JSON with broken token references and WCAG contrast findings and exits 1 on errors; run it before reporting the file done. `diff` exits 1 on regressions. `export` supports `json-tailwind`, `css-tailwind` and `dtcg`. On Windows PowerShell use the `designmd` alias (`npx -p @google/design.md designmd lint DESIGN.md`).
