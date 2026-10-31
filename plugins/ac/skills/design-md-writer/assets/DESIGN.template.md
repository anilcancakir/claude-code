# [Project name] design

## Overview

[One paragraph: how the system works end to end, in terms of the parts below.]

```text
[One diagram, under 20 lines: components and the direction of data flow.]
```

## Components

### [Component name]

- Location: `[path/]`
- Responsibility: [one sentence]
- Depends on: [components]
- Invariants: [only rules local to this component; shared rules go in the Invariants table]

## Data flow

[Name of the path]:

1. [Step]: `[path:symbol]`
2. [Step]: `[path:symbol]`

## Data model

- [Entity and relation]: schema in `[path]`.

## Interfaces

- [External API, event or file format]: source in `[path]`; [invariant types cannot express].

## Invariants

| Rule | Why | How to verify |
|------|-----|---------------|
| [Rule] | [Reason] | [Test name or command] |

## Decisions

| Decision | Why | Rejected alternatives | Status |
|----------|-----|-----------------------|--------|
| [Choice] | [Reason] | [Option, and why not] | [Active / Revisit / Superseded] |

## Errors and testing

- Errors: [the error contract]
- Tests: [where they live, what each layer covers]

## Change guide

| To change | Touch | Also check |
|-----------|-------|------------|
| [Task] | `[paths]` | [coupled place or test] |

## Known gaps

- [Gap]: `[path]`

Last reviewed: [YYYY-MM-DD] after [trigger].
