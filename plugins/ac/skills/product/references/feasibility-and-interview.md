# Feasibility pass and interview protocol

The method behind phases 3 and 4 of `/ac:product`. Numeric thresholds and the stop condition are this skill's proposals; no source publishes a completeness test for a requirements interview. Checked 2026-10-31 against the sources at the end.

## Contents

- Feasibility checklist
- Market checklist
- Pass depth by mode
- Research briefs
- Interview protocol
- Question lint
- Sources

## Feasibility checklist

Spine: the four product risks (value, usability, feasibility, viability), with Shape Up's appetite and no-gos for scope.

| Dimension | Question | Evidence to collect | Go or no-go signal |
|---|---|---|---|
| Value | Who struggles with this today, and what do they use instead? | Three to five "last time" stories; the real alternatives, including spreadsheets and manual work | Go: people paid in time or money. No-go: only compliments |
| Usability | Can a first-time user find the core flow? | A sketch or prototype; for a feature, the app's existing patterns | Go: unaided completion (proposal) |
| Feasibility | Can it be built with the time, skills and stack at hand? | The unknowns list: new technical work never done, assumptions about how parts fit | Ask "possible within the appetite", not "possible". No-go: a core unknown survives its time box |
| Viability | Does it work for the business? | Maintenance load, pricing against running cost, support burden | Go: covers its cost (thresholds unverified) |
| Riskiest assumption | Which assumption, if wrong, kills it? | Map importance against evidence; test only high importance with weak evidence | Write the pass threshold before the test |
| Technical spike | Is the uncertainty extreme? | A time-boxed spike; overuse extends time to value | Go: question answered inside the box |
| Build, buy or integrate | Is it core to what makes the product different? | Split capabilities into core and non-core | Non-core: buy or integrate |
| Alternatives | Where are existing alternatives broken? | What people use now and what is broken about it | Go: clearly better or different. A feature matrix of famous competitors is noise |
| Market | Is there pain, spend and a reachable first channel? | The Market checklist below | Go: quoted pain and an observed price (the break-even waits for the interview's revenue target and conversion range). No-go or Low confidence on a new product: a decision for the user |
| Scope | Does a design fit the appetite? | Appetite as a number, then a design | No-go: it fits only by cutting the core |
| Kill | What result makes us stop? | Criteria written in advance, with a state and a date | Written before work starts |

## Market checklist

Every item is evidence an agent can collect from the open web and `gh`; none of it proves willingness to pay. Method names: April Dunford's positioning components, Traction's bullseye, The Mom Test, jobs to be done.

- **Alternatives**: direct, indirect and do-nothing (spreadsheet, manual routine, living with it), three to five per bucket. Look in GitHub (`gh search repos`, with stars, last push and open issues), Product Hunt, G2, app stores, Hacker News "Show HN" and "alternative to X" threads, and Reddit. Record per alternative in `.ac/product/<slug>/feasibility.md`: type, URL, the job it serves, price, last activity and an evidence link; the PRD keeps the top three. No competitor found usually means no demand or the wrong search terms, not good news.
- **Pain evidence**: count the distinct linked threads and one to three star reviews that quote the problem. It shows pain, not size or willingness to pay.
- **Revealed spend**: the public pricing pages of the alternatives (tiers, price metric, free tier). "Contact sales" or a page that does not render is `unknown`, never estimated. Report a range and its metric.
- **Interest trend**: Google Trends only as a direction against a named alternative; its values are relative (0 to 100), not volume.
- **Attention**: stars and upvotes are attention, never demand. Show them apart and keep them out of the verdict.
- **Positioning draft**: Dunford's components (alternatives, unique attributes, value and proof, target, category), labelled a hypothesis for the interview. Phrase the job-to-be-done situation from quoted complaints, not invented personas.
- **Channel hypotheses**: two or three (Traction's bullseye idea), each with a cheap test and a kill criterion, grounded in where the complaints live and which channels competitors visibly use.
- **Sizing**: no top-down TAM by default. Phase 3 collects the observed price and the reachable-pool proxy (labelled an upper bound); the break-even is computed in phase 5 once the interview's Scope step has the user's target monthly revenue and conversion range: customers needed = target monthly revenue / observed price, compared with the pool times the conversion range. Conversion is a range the user sets, never the agent's guess.
- **Confidence**: tag every number `sourced` (URL and date), `derived` (formula shown) or `assumption` (owner named); `unknown` is a valid value. Rate each dimension High (two independent sources, one primary), Medium, or Low (one secondary source or inference). Demand backed only by forum threads is capped at Low, and search snippets are labelled snippets.
- **Commitment signals**: time, reputation or money (The Mom Test) cannot be collected by an agent. Output three interview asks for the user to run instead.
- **Steering**: a no-go or Low-confidence market on a new product goes to the user as a decision (narrow the target, change the positioning, or continue with the risk named), and the answer goes into the interview log.

## Pass depth by mode

- **New product**: the whole table and the full Market checklist. Sizing stays bottom-up and small (the break-even check); skip a top-down figure.
- **Feature in an existing project**: from the Market checklist run Alternatives and Revealed spend only, unless the user asks for more. Read the code first, then run Feasibility, Riskiest assumption, Scope and Kill. Add Build, buy or integrate when the feature brings a new dependency.
- A no-go on a core dimension stops the run for a decision: change the scope, continue with the risk named, or drop it.

## Research briefs

Use the brief shape in phase 3 of `SKILL.md` (CONTEXT, GOAL, DEPTH, BUDGET, DOWNSTREAM, REQUEST), one angle per brief, in one message.

- `ac:librarian`, new product: (1) real alternatives and open-source prior art; (2) public pricing pages of the leading alternatives (each brief finds the leaders itself, so both go out in one message); (3) pain evidence and interest trend; (4) technical feasibility of the one or two riskiest unknowns; (5) build, buy or integrate options for non-core capabilities. Three to five briefs. Market briefs go to `ac:librarian` like the others, with DEPTH and BUDGET set, never to a general-purpose agent.
- `ac:librarian`, feature: one brief for alternatives and their pricing.
- `ac:explore`, a feature or an existing repository: current behaviour of the area, the data model, constraints and the tests that cover it. One or two briefs.
- Anything the user told you to leave out of research goes into every librarian brief; the agent does not read CLAUDE.md.

## Interview protocol

0. **Read before asking.** For an existing repository, read `PROJECT.md`, the README, the manifest, the entry points, the data model and the tests. Never ask what the code or the research already answers.
1. **Frame.** Echo the request back in your own words, then ask the one open question whose answer changes what gets built the most.
2. **Stories.** Ask about the last time it happened, not about opinions of the idea. For a new product, walk the timeline: first thought, first event, active looking, second event, decision. Use five whys only on a stated solution, and stop when the cause is reached rather than at five.
3. **Decisions.** Rounds of up to three questions on related decisions, each option carrying the concrete artifact and your recommendation first.
4. **Scope.** Appetite, non-goals, must, should and could, one success metric, one counter-metric, a kill criterion. For a new product also the target monthly revenue and the expected conversion range, which the break-even needs.
5. **Playback.** Summarise what the user said and what you proposed, labelled separately, in chunks of 200 to 300 words.

Coverage categories to sweep (adapted from spec-kit's clarify taxonomy): problem and users, outcome and metrics, scope and non-goals, journeys, data and entities, constraints and integrations, edge cases and failure, UX and visual direction, rollout.

**Stop condition (proposal).** Stop when every PRD field holds a user statement or an accepted recommendation, the last round produced no new decision, and the user confirms the playback. Do not judge completeness alone: in a published evaluation LLM interviewers fully elicited at most 61 percent of requirements, ended interviews early and once invented a price.

For a high product risk, an interview cannot validate the idea. Propose a spike or a prototype instead of more questions.

## Question lint

Check each question against this list before asking.

- One requirement per question.
- No solution request ("should we use Redis?") when the problem is not settled.
- No jargon the user did not use.
- No leading phrasing, no "would you use it" hypotheticals; ask about past behaviour.
- No vague wording ("something modern"); give concrete options.
- The recommended option is first and the reason is in its description.

## Sources

- Four product risks: https://www.svpg.com/four-big-risks/
- Appetite, rabbit holes, no-gos, circuit breaker: https://basecamp.com/shapeup/1.2-chapter-03, https://basecamp.com/shapeup/1.4-chapter-05
- Assumption testing: https://www.producttalk.org/2023/10/assumption-testing/
- spec-kit clarify and specify, pinned: https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/clarify.md
- BMAD PRD template, pinned: https://github.com/bmad-code-org/BMAD-METHOD/blob/61e01f82644c4bb533750cfa0d6d61ab61d2cc9b/skills/bmad-prd/assets/prd-template.md
- Interviewing for past behaviour: https://www.producttalk.org/best-customer-interview-questions/
- LLM requirements interviews: https://arxiv.org/html/2507.02564v1
- Market checklist, practitioner sources: April Dunford (Obviously Awesome), Weinberg and Mares (Traction), Rob Fitzpatrick (The Mom Test), jobs to be done.
