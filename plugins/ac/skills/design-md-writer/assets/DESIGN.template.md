---
version: alpha
name: [Project name]
description: [One line: the product and how it should feel]
colors:
  primary: "[#hex]"
  on-primary: "[#hex]"
  surface: "[#hex]"
  on-surface: "[#hex]"
  on-surface-muted: "[#hex]"
  outline: "[#hex]"
  error: "[#hex]"
typography:
  display:
    fontFamily: [Typeface]
    fontSize: [44px]
    fontWeight: [700]
    lineHeight: [48px]
  body-md:
    fontFamily: [Typeface]
    fontSize: [16px]
    fontWeight: [400]
    lineHeight: [24px]
  label-md:
    fontFamily: [Typeface]
    fontSize: [14px]
    fontWeight: [600]
    lineHeight: [20px]
rounded:
  sm: [4px]
  md: [8px]
  full: 9999px
spacing:
  base: [8px]
  md: [16px]
  lg: [24px]
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  caption:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-md}"
---

## Overview

[Brand character in two or three sentences: the audience, the job the interface does, the feel.]

## Colors

- **Primary ([#hex]) and On-primary ([#hex]):** [its one role, and the text colour that sits on it]
- **Surface ([#hex]), On-surface ([#hex]) and On-surface muted ([#hex]):** [where the text sits, and what the muted tone is for]
- **Outline ([#hex]):** [where hairlines appear]
- **Error ([#hex]):** [when it is used]

## Typography

[Each typeface, where it comes from (system stack, Google Fonts family, project files) and which role it plays.]

## Layout

[Grid, base spacing unit, breakpoints, density, alignment.]

## Elevation & Depth

[How depth is shown: the shadow values or the tonal steps, and what never gets a shadow.]

## Shapes

[The radius scale and where each step applies.]

## Components

[Per component: the states it has and the tokens each state uses.]

## Do's and Don'ts

- Do [a checkable rule].
- Don't [a pattern this brief rules out].
