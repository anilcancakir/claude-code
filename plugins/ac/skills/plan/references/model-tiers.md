# Model Tier Reference

Benchmark and capability snapshot used for tier assignment in `/ac:plan` Stage 5 (Tier Calibration field of each step) and consumed by `/ac:execute` Phase 1c (tier-to-model routing). Anthropic-reported numbers for SWE-bench Verified; SWE-bench Pro numbers for Sonnet 4.6 and Haiku 4.5 are from compiled tracking sources as of 2026-05.

## When to read this

Read in Stage 5 before assigning a `Tier:` field per step. The plan template's Tier Calibration table is a short summary; this file expands the capability summary and the decision heuristic.

## Tier table

| Model       | ID                                | SWE-bench Verified | SWE-bench Pro | Capability summary |
|-------------|-----------------------------------|--------------------|---------------|--------------------|
| Opus 4.8    | claude-opus-4-8                   | 87.6%              | 64.3%         | Frontier coding. Multi-file long-horizon work, cross-layer changes, architecture, self-verification. xhigh effort with adaptive thinking, 1M context. Expensive; over-kill for mechanical edits. |
| Sonnet 4.6  | claude-sonnet-4-6                 | 79.6%              | 49.8%         | 5x cheaper than Opus, 1.2pt behind on SWE-bench Verified. Reads broader context, avoids duplicating shared logic, cleaner frontend output. Standard implementation, pattern-following, refactor-with-pattern. The default junior tier. |
| Haiku 4.5   | claude-haiku-4-5-20251001         | 73.3%              | 39.45%        | Matches Sonnet 4 performance at lower cost and higher speed. Excels at parallelized execution, sub-agents, and high-volume operations. Mechanical work, config, rename, scaffold, single-file fix, parallel fan-out. |

## Tier decision heuristic

Apply to every step, not just the first:

1. How many files? 1 → quick candidate. 1-3 → junior. 3+ → senior.
2. Mechanical or contextual? Mechanical (literal edit, no surrounding-code understanding) → quick. Contextual (apply pattern, follow conventions) → junior. Cross-layer or architectural → senior.
3. Is the surrounding codebase disciplined? If chaotic or legacy, escalate quick → junior. Haiku cannot reliably navigate inconsistent style.
4. Detail check: can the step be described in 2-3 sentences with an outcome and a reference? If yes, the tier is well-matched. If the description balloons into line-by-line prescription, either the tier is too low or you are doing the work in the plan.
5. Criticality check: does the step touch a security-critical or correctness-critical surface? Surfaces in scope:
   - Authentication / authorization (login, password reset, session, token issuance, RBAC, RLS, Policy / Gate, OAuth flow).
   - Payment / billing / financial calculation (currency math, charge, refund, invoice, ledger).
   - Cryptographic operations (hash, sign, verify, encrypt, decrypt, JWT, HMAC, password hashing).
   - User-input → SQL / shell / file path (injection or traversal surface).
   - File upload / deserialization (RCE surface).
   - Migration with destructive operations (DROP, TRUNCATE, schema rename with data loss).

   If the step touches any of these, escalate the tier by one level: `quick` → `junior`, `junior` → `senior`. The capability delta between Sonnet 4.6 and Opus 4.8 (79.6% vs 87.6% on SWE-bench Verified) widens on subtle-bug surfaces; Opus performs more self-verification on security-critical logic. The cost asymmetry justifies the escalation: a bug in auth, payment math, or crypto ships silently and is expensive to find post-deploy, while a senior worker's extra correctness margin is cheap when scoped to the 1-3 critical steps a typical plan carries. This rule applies on TOP of rules 1-4: a quick-by-file-count auth-login step still escalates to junior; a junior-by-default policy rewrite still escalates to senior. Codebase-state escalation (rule 3) and criticality escalation (rule 5) stack.

## Tier-to-worker routing (used by /ac:execute)

| Tier | Worker subagent | Model | Effort |
|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `claude-haiku-4-5-20251001` | low |
| `junior` | `ac:plan-worker-junior` | `claude-sonnet-4-6` | medium |
| `senior` | `ac:plan-worker-senior` | `claude-opus-4-8` | high |

`/ac:execute` Phase 1d applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac:plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely (see the Steps section of `plan-template.md` for the verification step shape). The orchestrator runs the step's `Commands` directly via Bash and captures output to the `Evidence` paths. Per-step 4-layer verification still applies, but Layer A is the orchestrator's direct Bash execution, Layer B is largely n/a (no source files changed), Layer C IS the Evidence file, and Layer D applies. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.
