# Example DESIGN.md

An illustrative visual-identity file for a fictional project. It lints clean with `npx @google/design.md@0.4.0 lint` (0 errors, 0 warnings); each colour that is not a standard family name (`primary`, `secondary`, `tertiary`, `error`, `surface`, `background`, `outline`) is used by a component, because the linter warns about an orphaned token. Match its register: exact values in the front matter, one role sentence per colour, checkable Do's and Don'ts, and a direction with a point of view instead of a default palette.

````markdown
---
version: alpha
name: Tidewater
description: Berth booking for small marinas; calm, legible in sunlight, built around tide times.
colors:
  primary: "#C8321E"
  on-primary: "#FFFFFF"
  primary-hover: "#A62816"
  secondary: "#0F4C5C"
  on-secondary: "#FFFFFF"
  surface: "#F2F6F7"
  surface-raised: "#FFFFFF"
  on-surface: "#12262E"
  on-surface-muted: "#4A5F68"
  outline: "#B8C6CC"
  success: "#1F7A5A"
  error: "#B3261E"
typography:
  display:
    fontFamily: Barlow Condensed
    fontSize: 44px
    fontWeight: 700
    lineHeight: 48px
    letterSpacing: 0.01em
  headline-md:
    fontFamily: Barlow Condensed
    fontSize: 28px
    fontWeight: 600
    lineHeight: 32px
  body-md:
    fontFamily: Source Sans 3
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    fontFeature: "tnum"
  label-md:
    fontFamily: Source Sans 3
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0.02em
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  full: 9999px
spacing:
  base: 8px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
    height: 48px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
    height: 48px
  berth-card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  berth-caption:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-md}"
  status-free:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
---

## Overview

Tidewater is used on a phone, outdoors, by a harbour master or a skipper who has a few seconds and glare on the screen. The interface reads like harbour signage: condensed capitals for what matters, plain text for the rest, one signal colour for the one action that books a berth.

## Colors

- **Primary (#C8321E, buoy red):** the sole driver for booking actions. It never marks a status.
- **Secondary (#0F4C5C, deep channel):** navigation and secondary actions.
- **Surface (#F2F6F7) and Surface raised (#FFFFFF):** the page and the cards on it; the pale blue-grey keeps glare off white.
- **On-surface (#12262E) and On-surface muted (#4A5F68):** text; muted is for captions and meets 4.5:1 on the surface.
- **Success (#1F7A5A) and Error (#B3261E):** status only (berth free, berth blocked), always paired with an icon or a word.
- **Outline (#B8C6CC):** hairlines around inputs and tables.

## Typography

Barlow Condensed (Google Fonts) carries the display and headline roles in capitals-friendly weights. Source Sans 3 (Google Fonts) carries body and labels, with tabular figures so tide times and prices align in columns.

## Layout

An 8 px base unit. Single column under 600 px, two columns from 840 px. Dense lists keep 16 px between rows; the booking summary gets 48 px of air around it.

## Elevation & Depth

Depth comes from tone first: raised cards are white on the blue-grey page. One shadow exists, `0 1px 2px rgba(18, 38, 46, 0.12), 0 6px 16px rgba(18, 38, 46, 0.08)`, for the sheet that slides up over the map. Cards and buttons have none.

## Shapes

Restrained corners: 2 px on chips, 4 px on buttons and inputs, 8 px on cards. Nothing is pill-shaped except the tide-state indicator.

## Components

- **Button primary:** buoy red with white label, 48 px tall; hover darkens to the hover token, focus draws a 2 px outline in the secondary colour.
- **Button secondary:** deep channel with white label, same size.
- **Berth card:** white, 8 px radius, the berth number in the headline role and the tide window in body figures; the caption under it uses the muted text colour.
- **Status chip:** green with a white label and a check icon for a free berth; 2 px radius.

## Do's and Don'ts

- Do keep one buoy-red button per view.
- Do set tide times, prices and berth lengths in tabular figures.
- Do pair every status colour with an icon or a word.
- Don't use red for anything that is not a booking action.
- Don't add gradient washes, identical icon-topped cards or an eyebrow label above each heading.
````

What to notice:

- Each colour has one role, and the reason sits in prose beside the exact value.
- The linter reports a token no component references (`orphaned-tokens`), except a standard family name such as `error` or `outline`, so a colour the file defines is used by a component or removed.
- Elevation is prose because the spec has no shadow token group.
- The Do's and Don'ts can be checked in a review of the render, and the last one names generic patterns this brief rules out.
