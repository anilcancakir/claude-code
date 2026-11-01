<!-- ported-from: plugins/ac/skills/design-md-writer/references/visual-identity.md sha256:530fa3142067cad0793e20094e8b1c27d25ce90c6d0680005845caa0d68f36a6 -->
# Visual identity DESIGN.md format

Google Labs publishes DESIGN.md as a format for describing a visual identity to coding agents: machine-readable tokens plus prose rationale. This page condenses `docs/spec.md`, the README and the CLI source of `https://github.com/google-labs-code/design.md` at commit `6e5da53` (2026-10-16), read in full on 2026-11-01. The spec is `version: alpha`, the latest release of the CLI is 0.4.0 (2026-07-27) and the format warns to expect changes, so re-run `npx @google/design.md@0.4.0 spec` before relying on a detail.

## Contents

- File structure
- Token schema
- Section order
- Authoring for agents
- Tooling

## File structure

Two layers. YAML tokens come first, between `---` lines at the top of the file. Markdown follows, in `##` sections. The tokens are the normative values; the prose says why they exist and how to apply them, and the format's own philosophy note calls the prose the most important part.

The spec on its main branch (2026-10-16) also allows fenced `yaml` blocks inside sections, merged with the front matter; a top-level key defined twice is an error. The 0.4.0 parser already merges every `yaml` or `yml` fence it finds, although its bundled spec does not document them. Write the front matter form, and keep no illustrative `yaml` fence in the file, because it would be read as tokens.

```markdown
---
version: alpha
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
```

## Token schema

Top-level keys: `version` (optional, `alpha`), `name`, `description` (optional), `omitted` (optional), `colors`, `typography`, `rounded`, `spacing` and `components`. Groups may nest, and a token is addressed by its dot path (`colors.background.light`).

| Type | Format | Example |
|---|---|---|
| Color | Any CSS colour; hex recommended | `"#1A1C1E"`, `"oklch(62% 0.18 250)"` |
| Dimension | Number plus `px`, `em` or `rem` | `48px`, `-0.02em` |
| Spacing value | Dimension or a plain number | `16px`, `4` |
| Token reference | `{path.to.token}` | `{colors.primary}` |
| Typography | Object: `fontFamily`, `fontSize` (dimension), `fontWeight` (number), `lineHeight` (dimension or unitless), `letterSpacing` (dimension), `fontFeature`, `fontVariation` (strings) | see the example file |

Components take `backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height` and `width`. An unknown property is accepted with a warning, a variant such as hover or pressed is its own key with a related name (`button-primary-hover`), and the spec calls the component schema actively evolving.

References outside `components` must resolve to a primitive value. Inside `components` they may point at a composite such as `{typography.label-md}`.

`omitted` suppresses the missing-section findings for sections left out on purpose:

```yaml
omitted:
  - spacing
  - section: rounded
    reason: "No rounded corners in the brand book"
```

The spec defines no shadow or elevation token group; elevation lives in prose.

## Section order

Sections may be omitted; those present appear in this order: Overview (alias Brand & Style), Colors, Typography, Layout (alias Layout & Spacing), Elevation & Depth (alias Elevation), Shapes, Components, Do's and Don'ts. A `primary` colour is the one required token. Consumers keep an unknown section heading and accept unknown token names with valid values; a duplicate section heading is an error.

Conventional names, not normative: `primary`, `secondary`, `tertiary`, `neutral`, `surface`, `on-surface`, `error`; `headline-*`, `body-*`, `label-*`; rounded `none` to `full`.

## Authoring for agents

- Put exact values in tokens and the reason in prose. A token without a role sentence gets used arbitrarily; a role sentence without a token gets approximated.
- Give each colour one role ("the sole driver for interaction"), not a mood.
- Write Do's and Don'ts as concrete, checkable rules ("one tertiary button per view").
- Reference tokens with `{path}` inside components instead of repeating hex values. A token no component references draws an `orphaned-tokens` warning, except the standard family names (`primary`, `secondary`, `tertiary`, `error`, `surface`, `background`, `outline`) and a family a component already references, so define a colour only where something uses it.
- Derive tokens from the existing stylesheet or theme file when one exists, and verify against it. Ask the user only for brand intent the code cannot show.

## Tooling

Package `@google/design.md` (Node 18 or newer); the binaries are `design.md` and `designmd` (use the second on Windows). Pin the version, because the rule set and the schema are alpha.

```bash
npx @google/design.md@0.4.0 lint DESIGN.md
npx @google/design.md@0.4.0 diff DESIGN.md.old DESIGN.md
npx @google/design.md@0.4.0 export --format css-tailwind DESIGN.md > theme.css
npx @google/design.md@0.4.0 spec --rules-only --format json
```

- `lint [--format json] <file|->` exits 1 on errors. Output is `{findings:[{severity,path,message,rule}], summary:{errors,warnings,infos}}`.
- `diff <before> <after>` exits 1 when the second file has more errors or warnings.
- `export --format <fmt> <file|-> [--prefix X]` writes `css-tailwind` (Tailwind v4 `@theme`), `json-tailwind` (v3 `theme.extend`), `dtcg` (W3C Design Tokens JSON) or `css-vars` (`:root` custom properties). It exits 0 on success and 2 when the file is unreadable. There is no Flutter exporter.
- `spec --rules-only --format json` prints the live rule list; read severities there instead of copying them.

Rules at 0.4.0: `broken-ref` is an error (an unknown component sub-token is downgraded to a warning). `missing-primary`, `contrast-ratio` (WCAG AA 4.5:1 on a component's `backgroundColor` and `textColor` pair only), `orphaned-tokens`, `missing-typography`, `section-order`, `unknown-key` and `token-like-ignored` are warnings. `token-summary`, `omitted-rules` and `missing-sections` (which checks `spacing` and `rounded` only) are info. The model layer also warns about unrecognised typography sub-properties and token name collisions.
