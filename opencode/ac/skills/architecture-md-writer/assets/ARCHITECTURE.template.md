<!-- ported-from: plugins/ac/skills/architecture-md-writer/assets/ARCHITECTURE.template.md sha256:3295efe05070836a4f99cad57eeb2d6543aaa06d5dc4f86fbd3cad725d0bad08 -->
# [Project name] architecture

## Overview

[Three to six sentences on what the person changing the system must know that the directory names do not show.]

```text
[Optional diagram, under 15 lines, only for a shape the names do not show.]
```

## Codemap

### `[path/]`

- Owns: [one sentence]
- Must not: [the boundary, stated as an absence]
- Depends on: [modules]

## Invariants

| Rule | Why | Verify |
|------|-----|--------|
| [Rule, often an absence] | [Reason] | [Test name or command] |

## Flows

[Name of the path]:

1. [Step]: `[path:symbol]`
2. [Step]: `[path:symbol]`

## Decisions

| Decision | Why | Rejected alternatives | Status |
|----------|-----|-----------------------|--------|
| [Choice] | [Reason] | [Option, and why not] | [Active / Revisit / Superseded] |

## Change guide

| To change | Touch | Also check |
|-----------|-------|------------|
| [Task] | `[paths]` | [coupled place or test] |

## Cross-cutting

- Errors: [the error contract]
- Configuration: [where it is read, what overrides what]
- Testing: [where tests live, what each layer covers]

## Traps

- [Misleading or unfinished place]: `[path]`

## Glossary

- **[Term]**: [domain meaning, and the name it has in code]

Last reviewed: [YYYY-MM-DD] after [trigger].
