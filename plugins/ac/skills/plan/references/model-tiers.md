# Model Tier Reference

How `/ac:plan` Stage 5 assigns a tier to each step and how `/ac:execute` Phase 1c routes it. The benchmarks, effort
curves and cost measurements behind these rules are in `model-tiers-evidence.md`; read that only when changing a rule.

## Tiers

| Tier | Worker subagent | Model | Effort | Typical work | Relative cost per step |
|---|---|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `haiku` (Haiku 5.5; Haiku 4.5 on Bedrock, Vertex, Foundry) | medium | mechanical single-file edits: config, rename, scaffold | about a tenth of junior |
| `junior` | `ac:plan-worker-junior` | `sonnet` (Sonnet 5.5) | high | one to three files applying a known pattern | 1x |
| `junior-high` | `ac:plan-worker-junior-high` | `sonnet` (Sonnet 5.5) | high | junior-shaped work at borderline coupling or context depth, and `rule-none` | about 2x |
| `senior` | `ac:plan-worker-senior` | `opus` (Opus 5.5) | medium | cross-layer, architecture, migration, and every rule-5 escalation | about 4x junior, 2x junior-high |

The senior ratio is the price of every unnecessary escalation, so plan around it. Effort moves a model a few points;
the Opus-to-Sonnet gap is larger, which is why effort cannot stand in for the escalation rule 5 asks for.

## Tier decision heuristic

Apply to every step, not just the first.

1. How many files, and how coupled? 1 isolated file is a quick candidate. A handful of files applying a known pattern is junior. A genuinely cross-layer or long-horizon change (many coupled modules, architecture, migration) is senior. Coupling drives this, not raw file count.
2. Mechanical or contextual? Mechanical (literal edit, no surrounding-code understanding) is quick. Contextual (apply pattern, follow conventions) is junior. Cross-layer or architectural is senior.
3. Is the surrounding codebase disciplined? If chaotic or legacy, escalate quick to junior. Haiku cannot reliably navigate inconsistent style, and Haiku 5.5 trails Sonnet 5.5 on FrontierCode 1.1 Main (46.4% against 52.1%) and on Terminal-Bench 4.0 (39.2% against 70.6%). The reason is that capability gap; Haiku 5.5 does have an effort parameter.
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

   This rule applies on top of rules 1-4, and codebase-state escalation (rule 3) stacks with it.

**Name the rule in `Why this tier`.** Use the vocabulary `rule-1-cross-layer`, `rule-2-context`, `rule-3-codebase-state`, `rule-4-detail`, `rule-5-criticality`, `rule-none`, so tier assignment can be audited by grep instead of by reading prose.

**`rule-none`: the residual category.** The five rules are closed and known to be incomplete: irreversibility and atomicity or idempotency are the families that recur outside them. Inventing an attribution to a rule that does not fit is worse than admitting the gap, so when a step sits at the borderline of `junior` for a reason no numbered rule covers, write `rule-none: <one sentence naming the actual risk>` and assign **`junior-high`**, not `senior`.

`rule-none` routes to `junior-high` because it is about half the price of `senior` and marks the step as borderline;
a family that keeps recurring under `rule-none` is the signal to add a rule.

## Routing notes (used by /ac:execute)

`junior-high` is sourced from rules 1 through 3: borderline coupling, borderline contextual work, and codebase-state escalation. It is where "this is heavier than junior but not cross-layer" goes, and it was what made the effort-before-model guidance actionable. With both junior tiers at `high` on Sonnet 5.5 it no longer adds effort; it stays as the borderline signal until a re-measure decides its level.

The criticality rule (rule 5) does not route here. It escalates `junior` to `senior`, never to `junior-high`.

`/ac:execute` Phase 1c applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac:plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely. The orchestrator runs the step's `Commands` directly via Bash and captures output to the `Evidence` paths. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.
