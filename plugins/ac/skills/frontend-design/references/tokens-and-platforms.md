# Tokens and platform rules

Numeric rules for web, iOS, Android and Flutter UI, checked on 2026-10-30 against the sources at the end. A row marked (unverified) has no primary page behind it. Take a value from here only when the project's own tokens do not already set it.

## Contents

- Craft rules
- Targets, contrast and type
- iOS
- Material 3
- Where iOS and Material conflict
- Flutter
- Sources

## Craft rules

Paraphrased from the Refactoring UI authors' public material.

| Rule | Value |
|---|---|
| Hierarchy | By colour and weight, not size alone: two or three text colours (dark but not black, grey, lighter grey), two weights (400 or 500 for body, 600 or 700 for emphasis), no weight under 400 in UI |
| Text on a colour | White at reduced opacity or a hand-picked tone of the same hue, never grey |
| Separation | Prefer a shadow, a tinted background or more space over a border |
| Buttons | Primary solid, secondary outline or low contrast, tertiary link-style; red and bold only when the destructive action is the primary one |
| Icons | Do not scale a 16 to 24 px icon up three or four times; set it in a tinted shape |
| Shadows | Two parts (a tight dark ambient one, a large soft offset one); raise elevation with vertical offset, not blur; about five levels (inputs and buttons, dropdowns, panels, modals); lighter surfaces read as closer |
| Whitespace | Start with too much and remove; inputs 40 or 48 px tall |
| Line height | About 1.5 for body, toward 2 for wide lines, about 1 for large headings; smaller text gets taller |
| Palette | Eight to ten greys; five to ten shades per primary, named 100 to 900 with 500 as base; never generate shades with lighten or darken; tint the greys warm or cool |
| Labels | Drop a label when the format explains itself, otherwise make it subordinate |
| Process | Design a feature first, not a layout; detail comes later |

Unverified: spacing steps at least 25 percent apart on a 16 px base, 45 to 75 character lines, letter-spacing rules, per-state design (hover, pressed, disabled).

## Targets, contrast and type

| Item | Value |
|---|---|
| Touch target | 44 x 44 pt on iOS (28 minimum); 48 x 48 dp on Android with 8 dp between; 24 x 24 CSS px is the WCAG 2.2 AA floor, so use 48 px on the web for touch |
| Text contrast | 4.5:1, or 3:1 for large text (18 pt, or bold at 14 pt); Dark Mode on iOS also 4.5:1 |
| Focus | Visible keyboard focus on every interactive element; not obscured by sticky bars (WCAG 2.2 AA) |
| Never colour alone | State and error need a second cue: icon, text or shape |

## iOS

| Rule | Value |
|---|---|
| Type, Large default (size/leading, pt) | Body 17/22, Callout 16/21, Subhead 15/20, Footnote 13/18, Caption 12/16 and 11/13; Title 1 28/34, Title 2 22/28, Title 3 20/25, Large Title 34/41; minimum 11 pt |
| Dynamic Type | Layouts reflow at larger sizes; minimal truncation |
| Layout | Respect safe areas and margins; nothing under the Dynamic Island, status bar or tab bar |
| Colour | System semantic colours, no hard-coded values; light, dark and increased-contrast variants |
| Buttons | One or two prominent buttons per view |
| Tab bar | Navigation only, never actions; do not hide or disable tabs; avoid the "More" tab; five or fewer when customisable; floats above content |
| Liquid Glass | Controls and navigation layer only, never the content layer; sparingly; drop custom bar backgrounds |
| Motion | Purposeful and optional; avoid it on frequent interactions; let people cancel it; springs are tuned by damping and response, start at 100 percent damping and add overshoot only when a gesture carries momentum |
| Gestures | No custom gesture for a standard action, and never the only path; modals have an obvious dismiss |
| Haptics | System patterns for their documented meaning; do not overuse |

## Material 3

| Rule | Value |
|---|---|
| Type (sp/line height) | Display 57/64, 45/52, 36/44; Headline 32/40, 28/36, 24/32; Title 22/28, 16/24, 14/20; Body 16/24, 14/20, 12/16; Label 14/20, 12/16, 11/16 |
| Shape (corner radius, dp) | 0, 4, 8, 12, 16, 20, 28, 32, 48, full |
| Colour roles | primary, secondary, tertiary and error, each with a container and on-roles; surface-container lowest to highest; outline and outline-variant; dynamic colour from Android 12 |
| Elevation levels | 0 to 5 are 0, 1, 3, 6, 8, 12 dp; resting UI uses 0 to 3 |
| State layers | hover 0.08, focus 0.10, pressed 0.10, dragged 0.16, disabled 0.38 |
| Navigation | Navigation bar for three to five destinations; predictive back on Android 13+ |
| Window classes (width) | Compact under 600, medium 600 to 839, expanded 840 to 1199, large 1200 to 1599, extra-large 1600 and up |
| Motion | Duration and easing in `motion.md`; M3 Expressive moves components to spring tokens |

M3 Expressive (2025) adds shape morphing, emphasised type and spring motion. Google's own research warns that breaking familiar patterns hurts usability, so use it for a hero moment and keep the conventional components elsewhere.

## Where iOS and Material conflict

| Topic | Web | Flutter |
|---|---|---|
| Touch target | 48 px with an 8 px gap | 48 everywhere |
| Primary navigation | Bar under 600 px, rail from 600 px, five destinations at most | `CupertinoTabBar` on iOS, `NavigationBar` on Android |
| Back | Never block the browser back or the edge swipe; add a visible back control | Keep each platform's route transition |
| Type | System font stack in rem, sizes from the target platform's scale | Platform default fonts |
| Controls | One family per surface | `.adaptive` constructors on Switch, Slider, Checkbox, Radio, AlertDialog and progress indicators |
| Depth | Tonal surface roles plus the two-part shadows; no glass on content | Same |

## Flutter

- Map tokens to `ColorScheme`, `TextTheme` and a `ThemeExtension` (which needs `copyWith` and `lerp`) for tokens the theme has no slot for. No colour or size literal outside the theme files.
- Flutter 3.47 moved Material and Cupertino into the standalone `material_ui` and `cupertino_ui` packages, so imports change; check the project's Flutter version before writing them.
- Profile on a physical device in `--profile` mode; the frame budget is about 16 ms.

## Sources

- Refactoring UI tips: https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886, https://refactoringui.com/
- Apple HIG: https://developer.apple.com/design/human-interface-guidelines/ (typography, layout, color, buttons, tab-bars, materials, motion, gestures, accessibility)
- Material 3 tokens, pinned: https://github.com/material-components/material-web/tree/de5470f7ed6a653457ca8f5cc0e7f7602c7a8391/tokens/versions/latest/sass and https://github.com/material-components/material-components-android/tree/66b0eeb53afeb6025ffbbd37734b08e5bce197ed/docs/theming
- Android touch target: https://support.google.com/accessibility/android/answer/7101858; window size classes: https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes
- Flutter adaptation: https://docs.flutter.dev/platform-integration/platform-adaptations
- WCAG 2.2: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
