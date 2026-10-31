# Motion, performance and UX states

Decision table and numbers for animated, fast, user-friendly UI. Browser support is as of 2026-10-30 from web-features data; re-check a feature before shipping it without a guard. Items marked (heuristic) are this skill's judgment, not a sourced figure.

## Contents

- Numbers
- Decision table
- Motion budget
- Web platform status
- Flutter
- Feedback and states
- Sources

## Numbers

| Item | Value |
|---|---|
| Simple feedback | About 100 ms |
| Screen or panel change | 200 to 300 ms; 400 ms feels slow, 500 ms drags; the more frequent the animation, the shorter |
| M3 duration tokens | short 50, 100, 150, 200 ms; medium 250, 300, 350, 400; long 450 to 600; extra-long 700 to 1000 |
| M3 easing | standard `cubic-bezier(0.2, 0, 0, 1)`; emphasized decelerate `(0.05, 0.7, 0.1, 1)`; emphasized accelerate `(0.3, 0, 0.8, 0.15)` |
| Suggested pairs | Enter 400 ms emphasized or 250 ms standard; exit 200 ms |
| Springs | Tune by damping and response, not duration; start at 100 percent damping, add overshoot (about 80 percent) only for gestures with momentum; M3 default spatial damping 0.9 and stiffness 700, effects never overshoot |
| Web fallback easing | Standard easing |

## Decision table

| Effect | Technique | Performance guard | Reduced-motion fallback |
|---|---|---|---|
| Hover, press, toggle | CSS transition, 100 to 200 ms | `transform`, `opacity` and colour only | Keep colour and opacity, drop movement |
| Popover, dialog, toast enter and exit | `@starting-style` with `transition-behavior: allow-discrete` | Fade plus a small translate | Fade only |
| Springy feel | `linear()` easing from a generated curve | Short, gesture-driven only | Plain ease |
| Height to auto | `interpolate-size` inside `@supports` | Chrome and Edge only | Instant |
| In-page morph | `document.startViewTransition` behind an `if` guard | Small snapshots | `animation: none` or a crossfade |
| Page navigation in a multi-page site | `@view-transition { navigation: auto }` | No render blocking unless measured | Plain navigation |
| Scroll reveal or progress | `animation-timeline` inside `@supports` | Runs off the main thread | Show the final state |
| Parallax | Avoid | | Remove |
| Timelines, pinning, orchestration in React | Motion (`m` with `LazyMotion`, about 5 kb) or GSAP | Lazy-load; INP at most 200 ms | `gsap.matchMedia()` or Motion's reduced-motion hooks |
| Stateful illustration | Rive; Lottie only for playback | Lazy-load | Static frame |
| Flutter state change | Implicit animations (`AnimatedContainer`, `TweenAnimationBuilder`) | Profile on a device | `MediaQuery.disableAnimationsOf(context)` |
| Flutter shared element or fling | `Hero`; `SpringSimulation` through `animateWith` | 16 ms frames | Instant jump |

Use CSS and platform features first; add a library only where CSS cannot express the effect.

## Motion budget

All heuristic.

1. One signature moment per screen (a hero, a transition). Everything else is feedback under 200 ms.
2. At most about three elements move at once.
3. No new motion on frequent actions. Nothing blocks input; every animation can be interrupted.
4. Animate `transform` and `opacity` only; never layout. Hold INP at or under 200 ms, CLS at or under 0.1, LCP at or under 2.5 s (75th percentile).
5. Autoplay motion longer than 5 seconds gets a pause control (WCAG 2.2.2); parallax can trigger vestibular reactions (2.3.3).
6. Under `prefers-reduced-motion: reduce`, replace movement with fades; do not remove all feedback.

## Web platform status

| Feature | Status | Without a fallback? |
|---|---|---|
| `prefers-reduced-motion`, `linear()` | Widely available | Yes |
| `@starting-style`, popover | Newly available | Yes; the fallback is no entry animation |
| Same-document view transitions | Newly available (Firefox 144) | Guard with `if (!document.startViewTransition)` |
| Cross-document view transitions | Limited (no Firefox) | Enhancement only |
| Scroll-driven animations | Chrome 115, Safari 26, Firefox 159 | Wrap in `@supports` |
| Anchor positioning | Core is newly available | Core yes; avoid `position-visibility` |
| `interpolate-size`, `calc-size()` | Limited (Chrome and Edge 129) | Enhancement only |

## Flutter

Ladder: implicit animations, then explicit controllers, then physics. Impeller is the only engine on iOS and the default on Android API 29+; web still uses Skia. Profile with the performance overlay on a physical device in `--profile` mode; red bars mean jank, and if both graphs are red, diagnose the UI thread first.

## Feedback and states

| Item | Rule |
|---|---|
| Response time | 0.1 s: show the result and nothing more. Up to 1 s the flow holds. Past 1 s show that the system is working. Past 10 s show percent done |
| Loading | Under 1 s show nothing; a spinner for one module taking 2 to 10 s; a skeleton for a full page under 10 s; a progress bar beyond; reserve the size to avoid layout shift |
| Mutation | Optimistic update with a visible rollback and an error message on failure |
| Empty state | Say what the system status is, teach the next step, and offer the direct path to the key task |
| Forms | A visible label on every input (no placeholder-only labels), the right `type` and `autocomplete`; `<dialog>.showModal()` for modals (inert background, Esc to close) |
| Every screen | Designs loading, empty, error and success, not only the happy path |

## Sources

- M3 motion tokens, pinned: https://github.com/material-components/material-web/blob/de5470f7ed6a653457ca8f5cc0e7f7602c7a8391/tokens/versions/latest/sass/_md-sys-motion.scss
- Apple motion: https://developer.apple.com/design/human-interface-guidelines/motion; WWDC18 "Designing Fluid Interfaces": https://developer.apple.com/videos/play/wwdc2018/803/
- Durations and response times: https://www.nngroup.com/articles/animation-duration/, https://www.nngroup.com/articles/response-times-3-important-limits/, https://www.nngroup.com/articles/skeleton-screens/
- Compositor-only properties: https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count; Core Web Vitals: https://web.dev/articles/vitals
- View transitions: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; scroll-driven animations: https://developer.chrome.com/docs/css-ui/scroll-driven-animations
- Flutter: https://docs.flutter.dev/ui/animations, https://docs.flutter.dev/perf/ui-performance, https://docs.flutter.dev/perf/impeller
- WCAG 2.2 motion: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html, https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
