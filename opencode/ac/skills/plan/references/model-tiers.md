<!-- ported-from: plugins/ac/skills/plan/references/model-tiers.md sha256:35aa6408a79939a16edace44b8c0058f34a081e4b4b46f7bad05b48206b0dd64 -->

This port keeps the benchmark and cost evidence inline; the Claude Code source moved it to `model-tiers-evidence.md` to shrink what a run reads.

# Model Tier Reference

Routing table used for tier assignment in `/ac/plan` Stage 5 and consumed by the execute skill's Phase 1c. The models come from the ac routing config at `/Users/anilcan/Code/claude-code/opencode/ac/config/models.jsonc`: each tier maps to an ordered fallback chain of `provider/model#variant`, the first entry is the primary, and the rest are tried in order when the one before it fails. The routing the plugin runs on is the source of truth; the tables below are a snapshot taken on 2026-11-02, so call the `ac_models` tool when an exact model id decides something.

## Model shapes

One provider, `apimaster` (apimaster.ai, billed per token), serves every chain, with three GPT models. Effort costs tokens, so no chain goes above `high`:

| Model | Shape | Tiers it carries as primary | Role |
|---|---|---|---|
| GPT-6.1 Sol (`apimaster/gpt-6.1-sol`) | Opus- and Sonnet-shaped | `high`: `senior`, `plan-code-review`, `oracle`, the main session and the coordinate `auto-verifier`; `medium`: `junior`, `junior-high`, `plan-reviewer`, `design-director`, `librarian`, `qa-tester` and the coordinate `lane` | Coding Agent Index 54.1 at max effort (Astra 54.7 at five times the price); on the Intelligence Index it scores 50 at `high` and 46 at `medium`, the latter above Sonnet 5.5 at the `high` Claude Code gives it (41). Standard implementation, review, and cross-layer work. |
| GPT-6 Luna (`apimaster/gpt-6-luna`) | Haiku-shaped | `quick` (`medium`), `explore` (`low`), session titles (`low`) | A twentieth of the sol price. Weak at terminal work (Terminal-Bench 4.0: 15.7 against 30.8 for Haiku 5.5) but ahead of Haiku on code question answering (SWE-Atlas-QnA 38.2 against 33.9), which is what `explore` does. |
| GPT-6 Astra (`apimaster/gpt-6-astra`) | fallback only | second rung of every chain except `quick` and `explore` | Five times the sol price for half a point on the Coding Agent Index, so it is never a first rung: it catches a model-level failure of sol one effort step down (`medium` for the `high` tiers, `low` for the `medium` ones). |

A 5xx or malformed output moves to the next rung after `retryAttempts`; a 429 is retried on the same model through the `rateLimitBackoff` schedule (30 retries, about 4 minutes) before the chain moves on in order. `quick` and `explore` fall back to `gpt-6.1-sol#low`. A model the key's balance cannot pay for answers 403 `insufficient_user_quota`, on which the plugin cools that model alone for 30 minutes and the chain moves to its next rung, so run one tiny call per chain model before a long run. Plans read the installed routing through the `ac_models` tool, never this table.

## Variant

A variant (`low`, `medium`, `high`) is the reasoning-effort lever inside one model, and it is fixed per agent: the plugin sets each `ac/*` agent's model to the first entry of its tier chain, variant included (the frontmatter `model` matches the chain head). The plan does not set a variant per step, and the planner leaves the `subagent` tool's `model` parameter unset on every spawn it makes (research, oracle, reviewer), so each agent runs on its configured model.

Moving between models on failure belongs to the execute skill, not to the plan: when a worker fails on a provider error, execute takes the next entry of that tier's chain and re-spawns the worker on it, and only a failure attributed to the work itself escalates one tier. A variant bump is a within-model lever and cannot substitute for the gap between model shapes, which is why the tier decision below picks a worker rather than a variant.

This plugin's own contribution, which the model vendors leave general, is the subagent-role-to-tier mapping in the routing table below.

## Tier decision heuristic

Apply to every step, not just the first.

1. How many files, and how coupled? 1 isolated file is a quick candidate. A handful of files applying a known pattern is junior. A genuinely cross-layer or long-horizon change (many coupled modules, architecture, migration) is senior. Coupling drives this, not raw file count.
2. Mechanical or contextual? Mechanical (literal edit, no surrounding-code understanding) is quick. Contextual (apply pattern, follow conventions) is junior. Cross-layer or architectural is senior.
3. Is the surrounding codebase disciplined? If chaotic or legacy, escalate quick to junior. The fast models at variant `low` cannot reliably navigate inconsistent style; the reason is that capability gap, not a missing variant.
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

   Treat the escalation as a cost-asymmetry judgment rather than a measured one: no published benchmark isolates self-verification on security-critical code. What is certain is the premium: `senior` is the expensive and slow tier, the Opus-shaped model at its highest variant, and it runs the longest. On the Claude Code side of this workflow the premium turned out several times larger than first assumed, and criticality vocabulary was the largest single family behind senior assignment, with plans putting half of all steps on senior. The asymmetry is real but expensive, which is what the "decides, not touches" test above exists to correct.

   This rule applies on top of rules 1-4, and codebase-state escalation (rule 3) stacks with it.

**Name the rule in `Why this tier`.** Use the vocabulary `rule-1-cross-layer`, `rule-2-context`, `rule-3-codebase-state`, `rule-4-detail`, `rule-5-criticality`, `rule-none`, so tier assignment can be audited by grep instead of by reading prose.

**`rule-none`: the residual category.** The five rules are closed as written and known to be incomplete. Most senior justifications in practice name no word from any of them, and the two largest families outside the set are irreversibility ("irreversible", "unrecoverable", "does not roll back") and atomicity or idempotency ("idempotent", plus concurrency and races). Some steps stay unresolvable by the six criticality surfaces: an entitlement quota that is neither authorization nor currency math, a recurring destructive delete that is not a migration, an untrusted-input merge that may or may not be deserialization.

Those are real reasons to reach for a higher tier, and inventing an attribution to a rule that does not fit is worse than admitting the gap. So when a step sits at the borderline of `junior` for a reason no numbered rule covers, write `rule-none: <one sentence naming the actual risk>` and assign **`junior-high`**, not `senior`.

Routing the residual to `junior-high` is deliberate: it is cheaper and faster than `senior` per step and marks the step as borderline within the Sonnet-shaped workers (both junior tiers run GPT-6.1 Sol at `medium`, so the tier is a signal, not a stronger worker), so an unmodelled risk parks somewhere proportionate instead of defaulting to the most expensive tier in the ladder. `senior` stays reserved for what the numbered rules actually name. If one family keeps recurring under `rule-none`, that is the signal to add a rule rather than to keep paying for the ambiguity.

## Tier-to-worker routing (used by the execute skill)

| Tier | Worker subagent | Primary model | Fallback chain, in order |
|---|---|---|---|
| `quick` | `ac/plan-worker-quick` | `apimaster/gpt-6-luna#medium` | `apimaster/gpt-6.1-sol#low` |
| `junior` | `ac/plan-worker-junior` | `apimaster/gpt-6.1-sol#medium` | `apimaster/gpt-6-astra#low` |
| `junior-high` | `ac/plan-worker-junior-high` | `apimaster/gpt-6.1-sol#medium` | `apimaster/gpt-6-astra#low` |
| `senior` | `ac/plan-worker-senior` | `apimaster/gpt-6.1-sol#high` | `apimaster/gpt-6-astra#medium` |

The ladder is monotonic in cost. `quick` runs luna, a twentieth of sol's price. `junior` and `junior-high` run the same model at the same variant (sol at `medium`), so junior-high costs more per step only because heavier steps are routed there, not because it is a different worker. `senior` runs sol at `high`, which spends more reasoning tokens per step and is the price of every unnecessary escalation, so plan around it. No per-step cost has been measured in this harness yet; re-measure once a few dozen runs per tier exist rather than carrying numbers over from another harness.

Prefer `junior-high` over `senior` for work that is heavier than junior but not cross-layer. `junior-high` is sourced from rules 1 through 3: borderline coupling, borderline contextual work, and codebase-state escalation. It is where "this is heavier than junior but not cross-layer" goes. With both junior tiers on the same model and variant it adds no effort; it stays as the borderline signal until a measurement decides otherwise.

The criticality rule (rule 5) does not route here. It escalates `junior` to `senior`, never to `junior-high`. A variant is a within-model lever and cannot substitute for the cross-model gap on the surfaces rule 5 protects.

The execute skill's Phase 1c applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac/plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely. The orchestrator runs the step's `Commands` directly via `shell` and captures output to the `Evidence` paths. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.

## Coordinate tiers (used by the coordinate skill, not by plan steps)

Two agents sit outside the plan ladder because no plan step is ever assigned to them. The `coordinate` skill spawns them, and the plugin sets their model to the head of the chain below like any other agent's.

| Tier | Agent | Primary model | Fallback chain, in order | Why |
|---|---|---|---|---|
| `lane` | `ac/lane` | `apimaster/gpt-6.1-sol#medium` | `apimaster/gpt-6-astra#low` | A lane runs one bundle's plan and execute skills inside a worktree, which is the main session's job. It is Sonnet-shaped in the Claude Code plugin and keeps that shape here: sol at `medium`. |
| `auto-verifier` | `ac/auto-verifier` | `apimaster/gpt-6.1-sol#high` | `apimaster/gpt-6-astra#medium` | The verifier judges finished work against frozen criteria, so it takes the strongest first rung at `high`, as the oracle does. |

`maxLanes` is 2 and `maxParallel` is 3: apimaster publishes no request limit for the key, so lanes are capped by caution and by the balance, not by a rate-limit group, and every lane runs its own workers.

## Sources

- ac routing config (tier chains, variants, retry and cooldown settings): `/Users/anilcan/Code/claude-code/opencode/ac/config/models.jsonc`
- Provider and model declarations (apimaster, effort variants): `/Users/anilcan/Code/claude-code/opencode/ac/templates/opencode.jsonc`
- Worker agent definitions (frontmatter `model` is the head of the tier chain, which `src/agent-models.ts` also applies): `/Users/anilcan/Code/claude-code/opencode/ac/agents/plan-worker-*.md`
