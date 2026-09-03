# Model Tier Reference

Benchmark snapshot and routing table used for tier assignment in `/ac:plan` Stage 5 and consumed by `/ac:execute` Phase 1c. Numbers as of 2026-07 following the Claude Opus 5 release (2026-07-24).

## Provenance and comparability

Read this before quoting a number. Not every cell carries the same weight.

- **Opus 5 and Sonnet 5 figures are primary and directly comparable.** SWE-bench Verified and SWE-bench Pro for both models appear as extractable text in their system cards, and Opus 5's card carries a cross-model comparison table, so the deltas below come from one document rather than two vendor posts written months apart.
- **Sonnet 5's FrontierBench v0.1 figure comes from the Opus 5 card, not its own.** The 17% appears in Opus 5's cross-model comparison. Sonnet 5's own card reports a different, Cognition-built benchmark ("FrontierCode v1", 38.8%), which is not the same measurement and must not be substituted for it.
- **Secondary sources conflict and are not usable.** Third-party posts circulate 72.7% and 82.1% for Sonnet 5's SWE-bench Verified. The system card's 85.2% overrules them. Cite the system cards only.
- **Terminal-Bench is retired from this table.** The harness broke twice in one generation: Sonnet 5 was measured with mini-SWE-agent rather than Terminus-2, and Opus 5 dropped Terminal-Bench 2.1 entirely for FrontierBench v0.1. Pre-Sonnet-5 Terminus-2 scores are not comparable to anything here.
- **Haiku 4.5 has no SWE-bench Pro figure.** Anthropic's launch post confirms it was not run.

## Tier table

| Model | ID | SWE-bench Verified | SWE-bench Pro | FrontierBench v0.1 | Capability summary |
|-----------|---------------------------|--------------------|---------------|--------------------|--------------------|
| Opus 5 | claude-opus-5 | 96.0% | 79.2% | 44.4% (xhigh) | Frontier agentic coding. Holds a ~16-point SWE-bench Pro lead and a 27-point FrontierBench lead over Sonnet 5, both measured against the same harness. 1M context, 128k output, five effort levels, thinking on by default. $5 / $25 per MTok. Cross-layer work, architecture, migrations. |
| Sonnet 5 | claude-sonnet-5 | 85.2% | 63.2% | 17% | The speed-and-intelligence balance point, not a near-peer on the hardest cases. Strong on standard implementation and pattern application, reads broad context, avoids duplicating shared logic. 1M context, 128k output. $3 / $15 per MTok (introductory $2 / $10 through 2026-08-31). Standard implementation, pattern-following, refactor-with-pattern. |
| Haiku 4.5 | claude-haiku-4-5-20251001 | 73.3% | not reported | not reported | Fastest and cheapest at $1 / $5 per MTok, 200k context, 64k output. Does NOT support the `effort` parameter; scope its work through the briefing instead. Mechanical work, config, rename, scaffold, single-file fix, parallel fan-out. |

Fable 5 (`claude-fable-5`) sits above Opus 5 on price but is not the senior tier here: on FrontierBench v0.1 Opus 5 scores 44.4% against Fable 5's 33.7%, at half the price and lower latency. Fable 5 also always runs thinking and can return `stop_reason: "refusal"` with HTTP 200, which the worker report contract does not handle. Reach for it only on explicit user request.

## Effort

Anthropic's published guidance is that tuning effort is often a better lever than switching models, and that most tasks should run at the model's default effort. Rather than restating their reasoning here, follow their two decision procedures directly:

- Model selection matrix, the efficiency-first and capability-first strategies, and the effort-before-model rule: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model.md
- The Claude Code diagnostic for effort versus model, "did it not try hard enough, or did it not know enough": https://claude.com/blog/claude-model-and-effort-level-in-claude-code

The measured effort curve, from the Opus 5 system card section 8.5 on FrontierBench v0.1: `xhigh` 44.4%, `max` about 43% and within noise of `xhigh`, `high` 39% at 19% fewer output tokens, `low` 25% at 64% fewer. Two consequences: `max` buys nothing over `xhigh`, and effort moves a model about 5 points on this harness while the Opus-to-Sonnet gap on the same harness is 27.

This plugin's own contribution, which the vendor docs leave general, is the subagent-role-to-tier mapping in the routing table below.

## Tier decision heuristic

Apply to every step, not just the first.

1. How many files, and how coupled? 1 isolated file is a quick candidate. A handful of files applying a known pattern is junior. A genuinely cross-layer or long-horizon change (many coupled modules, architecture, migration) is senior. Coupling drives this, not raw file count.
2. Mechanical or contextual? Mechanical (literal edit, no surrounding-code understanding) is quick. Contextual (apply pattern, follow conventions) is junior. Cross-layer or architectural is senior.
3. Is the surrounding codebase disciplined? If chaotic or legacy, escalate quick to junior. Haiku cannot reliably navigate inconsistent style, and it has no effort lever to compensate.
4. Detail check: can the step be described in 2-3 sentences with an outcome and a reference? If yes, the tier is well-matched. If the description balloons into line-by-line prescription, either the tier is too low or you are doing the work in the plan.
5. Criticality check: does the step DECIDE security-relevant behaviour? **The list is closed.** The six surfaces:
   - Authentication / authorization (login, password reset, session, token issuance, RBAC, RLS, Policy / Gate, OAuth flow).
   - Payment / billing / financial calculation (currency math, charge, refund, invoice, ledger).
   - Cryptographic operations (hash, sign, verify, encrypt, decrypt, JWT, HMAC, password hashing).
   - User-input to SQL / shell / file path (injection or traversal surface).
   - File upload / deserialization (RCE surface).
   - Migration with destructive operations (DROP, TRUNCATE, schema rename with data loss).

   **Decides, not touches.** Escalate only when the step CHANGES the decision one of those surfaces makes. Adding a field to a login form touches authentication; changing which requests get through decides it. Rendering an invoice touches billing; computing the charged amount decides it. Reading a token touches crypto; choosing the signing algorithm or the verification path decides it.

   The test is a before-and-after, written into `Why this tier` as `rule-5-criticality: before <X>, after <Y>`, and both halves have to be concrete. "before: any member can cancel, after: owner only" fires the rule. "before: encrypted cast, after: encrypted cast" does not, and neither does a half you cannot fill in. Keying the test off the step's `Done when` alone is weaker, because the planner writes that field in the same breath and can satisfy it with an adjective.

   When it does fire, escalate the tier by one level: `quick` to `junior`, `junior` to `senior`, and `junior-high` to `senior` as well. Every criticality escalation lands on `senior`; none lands on `junior-high`.

   A step whose failure would merely be expensive to detect does not qualify. Authoring or restructuring prompt, instruction, agent-body, or documentation text is not a criticality surface, however load-bearing that text is. The rule protects surfaces where a defect ships silently and is exploited or loses money, not surfaces where a defect is merely annoying to find.

   Treat the escalation as a cost-asymmetry judgment rather than a measured one: no published benchmark isolates self-verification on security-critical code. What IS measured is the premium, and an earlier version of this rule had it wrong. It cited 1.67x, which is the input-price ratio between the two models, and assumed the rule would fire on the 1-3 critical steps a typical plan carries. Across 367 worker runs the real premium is **5.9x junior per step**, and across the 68 most recent plans criticality vocabulary was the largest single family behind senior assignment, with those plans putting half of all steps on senior against 35.7% before. The asymmetry is real but it is three to ten times more expensive than the rule assumed, which is what the "decides, not touches" test above exists to correct.

   This rule applies on top of rules 1-4, and codebase-state escalation (rule 3) stacks with it.

**Name the rule in `Why this tier`.** Use the vocabulary `rule-1-cross-layer`, `rule-2-context`, `rule-3-codebase-state`, `rule-4-detail`, `rule-5-criticality`, `rule-none`, so tier assignment can be audited by grep instead of by reading prose.

**`rule-none`: the residual category.** The five rules are closed as written and known to be incomplete. Measured across 289 senior justifications in the 68 most recent plans, 55% name no word from any of them, and the two largest families outside the set are irreversibility (21 mentions of "irreversible", "unrecoverable", "does not roll back") and atomicity or idempotency (13 for "idempotent", plus concurrency and races). Independent classification of a 23-step sample left 17% unresolvable by the six criticality surfaces: an entitlement quota that is neither authorization nor currency math, a recurring destructive delete that is not a migration, an untrusted-input merge that may or may not be deserialization.

Those are real reasons to reach for a higher tier, and inventing an attribution to a rule that does not fit is worse than admitting the gap. So when a step needs more than `junior` for a reason no numbered rule covers, write `rule-none: <one sentence naming the actual risk>` and assign **`junior-high`**, not `senior`.

Routing the residual to `junior-high` is deliberate: it is 3.2x cheaper than `senior` per step and still a real step up from `junior`, so an unmodelled risk parks somewhere proportionate instead of defaulting to the most expensive tier in the ladder. `senior` stays reserved for what the numbered rules actually name. If one family keeps recurring under `rule-none`, that is the signal to add a rule rather than to keep paying for the ambiguity.

## Tier-to-worker routing (used by /ac:execute)

| Tier | Worker subagent | Model | Effort | Runs | Turns | Output | Cache read | Cost per step |
|---|---|---|---|---|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `claude-haiku-4-5-20251001` | not supported (Haiku 4.5 has no effort parameter) | 7 | 14.3 | 5,858 | 0.6M | ~$0.09 |
| `junior` | `ac:plan-worker-junior` | `claude-sonnet-5` | medium | 113 | 27.7 | 16,276 | 2.6M | ~$1.02 |
| `junior-high` | `ac:plan-worker-junior-high` | `claude-sonnet-5` | high | 40 | 36.1 | 27,846 | 4.9M | ~$1.89 |
| `senior` | `ac:plan-worker-senior` | `claude-opus-5` | high | 207 | 58.7 | 51,981 | 9.5M | ~$6.05 |

Measured across 367 real worker runs on 2026-09-03, from every `subagents/*.meta.json` on this machine, averaged per run. Cost per step applies published pricing to the measured output and cache read. Read it as an observational average rather than a controlled comparison: tiers draw different work by construction, so the column mixes tier effect with step difficulty.

The ladder is monotonic in cost, and the steps between rungs are large: junior-high is 1.9x junior, and senior is 3.2x junior-high and **5.9x junior**. That last ratio is the one to plan around, because it is the price of every unnecessary escalation to senior.

An earlier version of this table reported the opposite, that junior-high cost more per step than senior, and built guidance on it ("before assigning junior-high, try junior with a tighter briefing"). That came from a single 14-step plan in which junior-high happened to draw the harder steps. The 367-run measurement reverses it: junior-high sits where the ladder says it should, between junior and senior, at roughly a third of senior's cost. Prefer it over senior for work that is heavier than junior but not cross-layer.

`junior-high` is sourced from rules 1 through 3: borderline coupling, borderline contextual work, and codebase-state escalation. It is where "this is heavier than junior but not cross-layer" goes, and it is what makes the effort-before-model guidance actionable, because without it the only knob a planner has is the tier.

The criticality rule (rule 5) does not route here. It escalates `junior` to `senior`, never to `junior-high`. Effort moves Opus from 39% to 44.4% on FrontierBench v0.1, about 5 points, while the Opus-to-Sonnet gap on that same harness is 27 points. Effort is a within-model lever and cannot substitute for a cross-model gap on the surfaces rule 5 protects.

`/ac:execute` Phase 1c applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac:plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely. The orchestrator runs the step's `Commands` directly via Bash and captures output to the `Evidence` paths. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.

## Sources

- Claude Opus 5 system card (SWE-bench Verified 96.0%, SWE-bench Pro 79.2%, FrontierBench v0.1 44.4% plus the effort curve and the cross-model comparison carrying Sonnet 5's 17%): https://www-cdn.anthropic.com/c5fbac3f0b1280a933ebd26d3cb8bb9f5bdeaf48/Claude%20Opus%205%20System%20Card.pdf
- Claude Sonnet 5 system card (SWE-bench Verified 85.2%, SWE-bench Pro 63.2%): https://www-cdn.anthropic.com/480e0bb54327b9622282e9c39a83a4f490ed377e/Claude%20Sonnet%205%20System%20Card.pdf
- Introducing Claude Haiku 4.5 (SWE-bench Verified 73.3%, SWE-bench Pro not run): https://www.anthropic.com/news/claude-haiku-4-5
- Choosing the right model (selection matrix, effort-before-model rule): https://platform.claude.com/docs/en/about-claude/models/choosing-a-model.md
- Choosing a Claude model and effort level in Claude Code (the try-harder versus know-more diagnostic): https://claude.com/blog/claude-model-and-effort-level-in-claude-code
- Models overview (context, output, effort support, pricing, latency labels): https://platform.claude.com/docs/en/about-claude/models/overview.md
- Effort (supported-model list; Haiku 4.5 absent): https://platform.claude.com/docs/en/build-with-claude/effort.md
