<!-- ported-from: plugins/ac/skills/plan/references/model-tiers.md sha256:8dd9db17b03639e16580df609ad868a6167a96ab09c6526bc930f0d6bf32d630 -->
# Model Tier Reference

Routing table used for tier assignment in `/ac/plan` Stage 5 and consumed by the execute skill's Phase 1c. The models come from the ac routing preset at `/Users/anilcan/Code/claude-code/opencode/ac/config/models.jsonc`: each tier maps to an ordered fallback chain of `provider/model#variant`, the first entry is the primary, and the rest are tried in order when the one before it fails. The preset is the source of truth; the tables below are a snapshot of it taken on 2026-10-23, so re-read the file when an exact model id decides something.

## Model shapes

The preset splits the work by model shape across four model families on the codefast endpoints, and ends every chain with one Claude rung on the built-in `anthropic` provider:

| Model | Shape | Tiers it carries as primary | Role |
|---|---|---|---|
| GLM-5.3 (`codefast-glm/glm-5.3`) | Opus-shaped builder | `senior` (variant `max`), plus the main session and `plan-code-review` | Agentic coder trained against a Claude Code shaped harness (ZCode): cross-layer work, architecture, migrations, long-horizon changes where correctness depends on reasoning about behaviour. Reviews the workers' diff because it is a different family from them. |
| Kimi K3 (`codefast-kimi/kimi-k3`) | independent reviewer | `oracle` (variant `max`) and `plan-reviewer` (variant `high`) | A different family from whoever produced the artifact (planner GLM, so plan-reviewer Kimi; main GLM, so oracle Kimi), so review is a second eye rather than the author re-reading itself. The slowest model in the preset, acceptable because reviews are rare. |
| DeepSeek V4.1 Flash 1017 (`codefast-deepseek/deepseek-v4.1-flash-1017`) | Sonnet- and Haiku-shaped workhorse | `junior` and `junior-high` (variant `high`), `quick` and `explore` (variant `low`), plus `librarian` and `qa-tester` | Artificial Analysis Intelligence Index 45 (tied with GLM-5.3; Kimi K3 44, Qwen3.8 Flash 40), speed class 4/4 against GLM 3/4, Qwen 2/4, Kimi 1/4; operator test 12/12. Standard implementation, pattern application, mechanical edits and fan-out search. Its sibling `deepseek-v4.1-flash` is the last rung of the fast chains. |
| Qwen 3.8 Flash (`codefast-qwen/qwen3.8-flash`) | fast fallback | session titles | Second rung of the fast chains and last codefast rung of the junior, librarian and qa-tester chains. |
| Claude 5.5 (`anthropic/claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) | out-of-group last fallback | none in the default preset; every tier under the `claude` preset | Tier-matched as in the Claude Code ac plugin: Opus for main, oracle and plan-code-review (`high`) and plan-reviewer and senior (`medium`); Sonnet at `high` for junior, junior-high, librarian and qa-tester; Haiku at `medium` for quick and explore. Paid per token through an API key, so it is the rung of last resort. |

The codefast rungs sit inside one shared rate-limit group, so they mainly cover model-specific errors (5xx, malformed output) and a group-wide 429 is waited out. The Claude rung is a separate group, so it is the one entry a codefast outage or a sustained 429 can still reach.

The `claude` preset (`/Users/anilcan/Code/claude-code/opencode/ac/config/presets/claude.jsonc`, applied with `bun scripts/install.ts --preset claude`) inverts the order: each chain leads with its Claude model and falls back to the first two codefast entries of the default chain. Re-running the installer without `--preset` restores the default.

## Variant

A variant (`low`, `medium`, `high`, `max`) is the reasoning-effort lever inside one model, and it is fixed per agent: the plugin sets each `ac/*` agent's model to the first entry of its tier chain, variant included, whichever preset is installed (the frontmatter `model` matches the default preset's head). The plan does not set a variant per step, and the planner leaves the `subagent` tool's `model` parameter unset on every spawn it makes (research, oracle, reviewer), so each agent runs on its configured model.

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

Routing the residual to `junior-high` is deliberate: it is cheaper and faster than `senior` per step and marks the step as borderline within the Sonnet-shaped workers (both junior tiers run DeepSeek V4.1 Flash 1017 at `high`, so the tier is a signal, not a stronger worker), so an unmodelled risk parks somewhere proportionate instead of defaulting to the most expensive tier in the ladder. `senior` stays reserved for what the numbered rules actually name. If one family keeps recurring under `rule-none`, that is the signal to add a rule rather than to keep paying for the ambiguity.

## Tier-to-worker routing (used by the execute skill)

| Tier | Worker subagent | Primary model | Fallback chain, in order |
|---|---|---|---|
| `quick` | `ac/plan-worker-quick` | `codefast-deepseek/deepseek-v4.1-flash-1017#low` | `codefast-qwen/qwen3.8-flash#low`, `codefast-deepseek/deepseek-v4.1-flash#low`, `anthropic/claude-haiku-5-5#medium` |
| `junior` | `ac/plan-worker-junior` | `codefast-deepseek/deepseek-v4.1-flash-1017#high` | `codefast-glm/glm-5.3#high`, `codefast-qwen/qwen3.8-flash#high`, `anthropic/claude-sonnet-5-5#high` |
| `junior-high` | `ac/plan-worker-junior-high` | `codefast-deepseek/deepseek-v4.1-flash-1017#high` | `codefast-glm/glm-5.3#high`, `codefast-qwen/qwen3.8-flash#high`, `anthropic/claude-sonnet-5-5#high` |
| `senior` | `ac/plan-worker-senior` | `codefast-glm/glm-5.3#max` | `codefast-deepseek/deepseek-v4.1-flash-1017#max`, `codefast-kimi/kimi-k3#high`, `anthropic/claude-opus-5-5#medium` |

The ladder is monotonic in cost and latency. `quick` runs the workhorse model at `low`. `junior` and `junior-high` run the same model at the same variant, so junior-high costs more per step only because heavier steps are routed there, not because it is a different worker. `senior` runs the Opus-shaped model at `max`, the slowest and most expensive rung, and it is the price of every unnecessary escalation, so plan around it. No per-step cost has been measured on these models yet; re-measure once a few dozen runs per tier exist rather than carrying numbers over from another harness.

Prefer `junior-high` over `senior` for work that is heavier than junior but not cross-layer. `junior-high` is sourced from rules 1 through 3: borderline coupling, borderline contextual work, and codebase-state escalation. It is where "this is heavier than junior but not cross-layer" goes. With both junior tiers on the same model and variant it adds no effort; it stays as the borderline signal until a measurement decides otherwise.

The criticality rule (rule 5) does not route here. It escalates `junior` to `senior`, never to `junior-high`. A variant is a within-model lever and cannot substitute for the cross-model gap on the surfaces rule 5 protects.

The execute skill's Phase 1c applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac/plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely. The orchestrator runs the step's `Commands` directly via `shell` and captures output to the `Evidence` paths. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.

## Sources

- ac routing preset (tier chains, variants, retry and cooldown settings): `/Users/anilcan/Code/claude-code/opencode/ac/config/models.jsonc`
- Claude preset (Claude-first chains, title model): `/Users/anilcan/Code/claude-code/opencode/ac/config/presets/claude.jsonc`
- Worker agent definitions (frontmatter `model` is the default preset's chain head; `src/agent-models.ts` applies the installed preset's): `/Users/anilcan/Code/claude-code/opencode/ac/agents/plan-worker-*.md`
