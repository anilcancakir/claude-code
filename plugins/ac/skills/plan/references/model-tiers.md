# Model Tier Reference

Benchmark and capability snapshot used for tier assignment in `/ac:plan` Stage 5 (Tier Calibration field of each step) and consumed by `/ac:execute` Phase 1c (tier-to-model routing). Numbers as of 2026-07 following the Claude Opus 5 release (2026-07-24).

## Provenance and comparability

Read this before quoting a number. Not every cell carries the same weight.

- **Opus 5 and Sonnet 5 figures are primary and directly comparable.** Both SWE-bench Verified and SWE-bench Pro for the two models appear as extractable text in the Opus 5 and Sonnet 5 system cards, and Opus 5's card carries a cross-model comparison table, so the Opus-vs-Sonnet deltas below come from the same document rather than from two vendor posts written months apart.
- **Sonnet 5's SWE-bench Verified is now resolved.** Earlier revisions of this file showed `see note` because the figure was not published as extractable text. It is now confirmed at 85.2% in Sonnet 5's own system card, superseding the conflicting secondary-source estimates (72.7%, 82.1%) that this file previously flagged.
- **Terminal-Bench is retired from this table.** The harness broke twice in one generation: Sonnet 5 was measured with mini-SWE-agent rather than Terminus-2 (Anthropic switched because Terminus-2 produced 2.7x more timeouts at high effort), and Opus 5 dropped Terminal-Bench 2.1 entirely in favor of FrontierBench v0.1, the same team's harder successor. Pre-Sonnet-5 Terminus-2 scores are therefore NOT comparable to Sonnet 5's 80.4% or to any Opus 5 number. The agentic column below uses FrontierBench v0.1, where Opus 5 and Sonnet 5 were measured on the same harness.
- **Haiku 4.5 has no SWE-bench Pro figure.** Anthropic's launch post confirms it was not run, so the cell reads "not reported" rather than being filled from a third party.
- **Opus 4.8 is no longer in the ladder** and its numbers are kept only as migration context in the note below. Its SWE-bench Verified 88.6% rests on consistent secondary-source citation; its SWE-bench Pro 69.2% is primary-confirmed through Opus 5's cross-model table.

## When to read this

Read in Stage 5 before assigning a `Tier:` field per step. The plan template's Tier Calibration table is a short summary; this file expands the capability summary and the decision heuristic.

## Tier table

| Model | ID | SWE-bench Verified | SWE-bench Pro | FrontierBench v0.1 | Capability summary |
|-----------|---------------------------|--------------------|---------------|--------------------|--------------------|
| Opus 5 | claude-opus-5 | 96.0% | 79.2% | 44.4% (xhigh) | Frontier agentic coding. Holds a ~16-point SWE-bench Pro lead and a 27-point FrontierBench lead over Sonnet 5, both measured against the same harness. Anthropic's own steering is to start here for complex agentic coding. 1M context, 128k output, five effort levels, thinking on by default. $5 / $25 per MTok. Cross-layer work, architecture, migrations, correctness-critical logic. |
| Sonnet 5 | claude-sonnet-5 | 85.2% | 63.2% | 17% | The speed-and-intelligence balance point, not a near-peer on the hardest cases. Strong on standard implementation and pattern application, reads broad context, avoids duplicating shared logic, 1M context, 128k output. $3 / $15 per MTok (intro $2 / $10 through 2026-08-31), roughly 40% cheaper than Opus 5. Standard implementation, pattern-following, refactor-with-pattern. |
| Haiku 4.5 | claude-haiku-4-5-20251001 | 73.3% | not reported | not reported | Fastest and cheapest at $1 / $5 per MTok, 200k context, 64k output. Does NOT support the `effort` parameter; scope its work through the briefing instead. Manual extended thinking only, adaptive not accepted. Mechanical work, config, rename, scaffold, single-file fix, parallel fan-out. |

Fable 5 (`claude-fable-5`) sits above Opus 5 on price and general capability but is NOT the senior tier here: on FrontierBench v0.1, the agentic-coding harness closest to this plugin's workload, Opus 5 scores 44.4% against Fable 5's 33.7%, at half the price and lower latency. Fable 5 also always runs thinking and can return `stop_reason: "refusal"` with HTTP 200, which the worker report contract does not handle. Reach for it only on explicit user request.

## Tier decision heuristic

Apply to every step, not just the first.

The generational gap widened. When the senior tier was Opus 4.8, the Opus-to-Sonnet SWE-bench Pro gap was about 6 points and Sonnet led the then-current Terminal-Bench, which justified treating Sonnet as a near-peer default and reserving senior narrowly. Both premises are now void: the Pro gap is about 16 points, the FrontierBench gap is 27 points, and the Terminal-Bench comparison that favored Sonnet was against Opus 4.8 on a harness Anthropic has since replaced. Sonnet 5 remains the right default for standard pattern work on speed and cost, but do not treat it as near-Opus on genuinely hard work.

1. How many files, and how coupled? 1 isolated file → quick candidate. A handful of files applying a known pattern → junior. A genuinely cross-layer or long-horizon change (many coupled modules, architecture, migration) → senior. Coupling drives this, not raw file count.
2. Mechanical or contextual? Mechanical (literal edit, no surrounding-code understanding) → quick. Contextual (apply pattern, follow conventions) → junior. Cross-layer or architectural → senior.
3. Is the surrounding codebase disciplined? If chaotic or legacy, escalate quick → junior. Haiku cannot reliably navigate inconsistent style, and it has no effort lever to compensate.
4. Detail check: can the step be described in 2-3 sentences with an outcome and a reference? If yes, the tier is well-matched. If the description balloons into line-by-line prescription, either the tier is too low or you are doing the work in the plan.
5. Criticality check: does the step touch a security-critical or correctness-critical surface? Surfaces in scope:
   - Authentication / authorization (login, password reset, session, token issuance, RBAC, RLS, Policy / Gate, OAuth flow).
   - Payment / billing / financial calculation (currency math, charge, refund, invoice, ledger).
   - Cryptographic operations (hash, sign, verify, encrypt, decrypt, JWT, HMAC, password hashing).
   - User-input → SQL / shell / file path (injection or traversal surface).
   - File upload / deserialization (RCE surface).
   - Migration with destructive operations (DROP, TRUNCATE, schema rename with data loss).

   If the step touches any of these, escalate the tier by one level: `quick` → `junior`, `junior` → `senior`. The evidence for this rule strengthened with Opus 5: the two same-harness deltas (16 points on SWE-bench Pro, 27 points on FrontierBench v0.1) are the closest available proxy for hardest-case capability, and both widened. Anthropic publishes no difficulty-tiered SWE-bench Pro breakdown and no benchmark isolating self-verification on security-critical code, so treat the escalation as a cost-asymmetry judgment rather than a measured one: a bug in auth, payment math, or crypto ships silently and is expensive to find post-deploy, while the senior premium is 1.67x input cost scoped to the 1-3 critical steps a typical plan carries. This rule applies on TOP of rules 1-4, and codebase-state escalation (rule 3) stacks with it.

Effort before model. Anthropic frames the `effort` parameter as the first-line lever for balancing cost against capability without switching models. When a junior step underperforms, the routing table's `medium` effort for junior is the cheaper knob to reach for before escalating the step to senior; tier escalation is the second lever, not the first.

## Tier-to-worker routing (used by /ac:execute)

| Tier | Worker subagent | Model | Effort |
|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `claude-haiku-4-5-20251001` | not supported (Haiku 4.5 has no effort parameter) |
| `junior` | `ac:plan-worker-junior` | `claude-sonnet-5` | medium |
| `senior` | `ac:plan-worker-senior` | `claude-opus-5` | high |

`/ac:execute` Phase 1d applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac:plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely (see the Steps section of `plan-template.md` for the verification step shape). The orchestrator runs the step's `Commands` directly via Bash and captures output to the `Evidence` paths. Per-step 4-layer verification still applies, but Layer A is the orchestrator's direct Bash execution, Layer B is largely n/a (no source files changed), Layer C IS the Evidence file, and Layer D applies. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.

## Sources

- Claude Opus 5 system card (SWE-bench Verified 96.0%, SWE-bench Pro 79.2%, FrontierBench v0.1 44.4%, cross-model comparison table): https://www-cdn.anthropic.com/c5fbac3f0b1280a933ebd26d3cb8bb9f5bdeaf48/Claude%20Opus%205%20System%20Card.pdf
- Claude Sonnet 5 system card (SWE-bench Verified 85.2%, SWE-bench Pro 63.2%, Terminal-Bench harness change): https://www-cdn.anthropic.com/480e0bb54327b9622282e9c39a83a4f490ed377e/Claude%20Sonnet%205%20System%20Card.pdf
- Introducing Claude Haiku 4.5 (SWE-bench Verified 73.3%, SWE-bench Pro not run): https://www.anthropic.com/news/claude-haiku-4-5
- Introducing Claude Opus 5 (effort as the cost-capability lever, frontier framing): https://www.anthropic.com/news/claude-opus-5
- Models overview (context, output, effort support, pricing, latency labels, "start with Claude Opus 5" steering): https://platform.claude.com/docs/en/about-claude/models/overview.md
- Effort (supported-model list; Haiku 4.5 absent): https://platform.claude.com/docs/en/build-with-claude/effort.md
- Model deprecations (Opus 4.8, Sonnet 5, Haiku 4.5 all Active): https://platform.claude.com/docs/en/about-claude/model-deprecations.md
