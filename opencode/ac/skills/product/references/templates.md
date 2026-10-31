<!-- ported-from: plugins/ac/skills/product/references/templates.md sha256:7c4a9abf007e1ac670668e4ffc9423f74241c59cb60ecfba0de705b8980bea04 -->
# PRD, roadmap and task file templates

The three files `/ac/product` writes for a consumer to read. Every section earns its place; a section with nothing to say is dropped, not filled. Shapes follow the BMAD PRD spine (stable ids, a glossary, testable requirements, non-goals), Shape Up's appetite and no-gos, and a Now, Next, Later roadmap whose bundle fields map onto what `/ac/coordinate` needs to run bundles in parallel: `after` is its `depends_on`, `touches` its `hotspots`, `acceptance` its gate.

## Contents

- PRD
- Roadmap
- Task file for `/ac/plan`
- Handoff commands
- Rules

## PRD

Path `docs/prd/<slug>.md`. About two pages.

```markdown
# <Product or feature name>

Status: draft | accepted. Last reviewed: <date>. Appetite: <a time budget, not an estimate>.

## Problem
<Who struggles with what today, the last concrete story, and what they use instead. Three to six sentences.>

## Outcome
- Success metric: <one number with a window>
- Counter-metric: <what must not get worse>
- Kill criterion: <the result that makes us stop, written before work starts>

## Users and journeys
- UJ-1 <named protagonist>: <the path in three to six steps, ending at the outcome>

## Glossary
- <term>: <one line; used verbatim everywhere below>

## Requirements
- FR-1 (UJ-1): <what the system does>.
  - Given <state>, when <action>, then <observable result>.

## Non-goals
- <something that could reasonably be a goal and is chosen not to be>

## Rabbit holes and feasibility
| Risk | Finding | Decision |
|---|---|---|
| <value, usability, feasibility, viability, or a named unknown> | <the evidence, with its source> | <what we do about it> |

## Market (confidence <High | Medium | Low per dimension>, retrieved <date>)
- Alternatives: <the top three across direct, indirect and do-nothing, each with URL and price; the full list stays in `.ac/product/<slug>/feasibility.md`>
- Job and situation: <phrased from quoted complaints>
- Positioning (hypothesis): <for the interview, not a decision>
- Demand evidence: <count of linked threads and reviews, trend direction; attention (stars, upvotes) shown apart>
- Pricing benchmark: <range, metric, sources; unknown where hidden>
- Break-even: <target monthly revenue / observed price = customers needed, against the assumed conversion range>
- Channel hypotheses: <up to three, each with a cheap test and a kill criterion>
- Unknowns and what would change the direction: <...>. Interview asks: <three time, reputation or money asks for the user>

## Assumptions and open questions
- A-1 [<tag>]: <the assumption or question>. Blockers are marked; at most three.
```

## Roadmap

Path `docs/ROADMAP.md`, one per repository. A feature in an existing project appends its bundles under Now or Next and continues the id sequence.

```markdown
# Roadmap

Now, Next, Later. A bundle is a vertical slice that ships on its own. Two bundles may run in parallel when every `after` is met and their `touches` do not overlap.

## Now

### b1 <outcome in one line>
- covers: FR-1, FR-2
- after: none
- touches: <paths or areas>
- appetite: <a time budget>
- acceptance: Given <state>, when <action>, then <result>; proven by `<command>`
- status: planned

## Next

### b3 <outcome in one line>
- covers: FR-4
- after: b1
- touches, appetite and acceptance are filled when it moves to Now

## Later
- <a problem statement only; no solution yet>
```

## Task file for `/ac/plan`

Path `.ac/tasks/<slug>-b<N>.yaml`, one per bundle. `/ac/plan` reads `type`, the user story and the acceptance criteria as the request body (the task YAML handling in the `plan` skill).

```yaml
type: feature
source: docs/prd/<slug>.md
user_story: As <the protagonist of the journey>, I want <the bundle's outcome> so that <the value>.
acceptance_criteria:
  - Given <state>, when <action>, then <result>
```

## Handoff commands

Print them; never run them. The user decides which consumer fits.

- One bundle, planned in detail: `/ac/plan .ac/tasks/<slug>-b1.yaml`
- Several bundles in parallel lanes: `/ac/coordinate` takes a request string and drafts its own roadmap; it does not open `docs/ROADMAP.md` by itself. Write the settled bundles into the string and name the files: `/ac/coordinate "<outcome>. Settled bundles: b1 <outcome> (acceptance: <one line>); b2 <outcome>, after b1; ... Read docs/prd/<slug>.md and docs/ROADMAP.md before drafting. The bundles and their order are decided: confirm them, do not re-derive them."` The coordinator may still ask about boundaries.
- A small bundle needs no command: describe it in a normal message and the working rules size it.

## Rules

- Ids are stable and never renumbered: `UJ-n`, `FR-n`, `A-n`, `b<N>`. A dropped item keeps its id and is marked dropped.
- Every `FR` realizes at least one `UJ`, and every `FR` is covered by a bundle or listed as deferred under Later.
- Every bundle has `covers`, `after`, `touches` and an `acceptance` a command or a person can check. A bundle with no `acceptance` has no gate in `/ac/coordinate`.
- One test notation, Given, when, then. Not EARS as well.
- No technology choices in the PRD; they belong in `PROJECT.md` or in a lane's decisions. No dates, no personas section, no ROI or stakeholder sections, no press-release prose.
- When shared setup blocks the rest, the first bundle is `b0` (foundation) and every other bundle is `after: b0`.
- `status` is `planned`, `in progress` or `done`, set by the user or when a bundle merges. `/ac/coordinate` keeps its own state under `.ac/coord/<slug>/` and does not read this field.
- Market: every number is tagged `sourced`, `derived` or `assumption`, and `unknown` is a valid value; nothing is estimated to fill a gap. A feature carries only Alternatives and Pricing benchmark.
- Size: a PRD past about two pages overflows into `docs/prd/<slug>-addendum.md`. A reader agent loses the middle of a very long input silently.
