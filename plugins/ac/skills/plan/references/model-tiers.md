# Model Tier Reference

Benchmark and capability snapshot used for tier assignment in `/ac:plan` Stage 5 (Tier Calibration field of each step) and consumed by `/ac:execute` Phase 1c (tier-to-model routing). Numbers as of 2026-07 from Anthropic sources (anthropic.com/news, platform.claude.com) plus the launch benchmark tables. Confidence notes: Opus 4.8 SWE-bench Verified 88.6% and Haiku 4.5 73.3% are corroborated; Sonnet 5's SWE-bench Verified is not published as extractable text (the system-card tables are images) and secondary sources conflict (72.7% is implausible, below Haiku's 73.3%; 82.1% is plausible but unconfirmed), so it is shown as `see note` and Sonnet 5's coding strength is carried by the verified Terminal-Bench (80.4%) and SWE-bench Pro (63.2%) figures instead. Pull the exact SWE-bench Verified from the Claude Sonnet 5 system card if a precise percentage is needed. Terminal-Bench figures use the Terminus-2 harness (Opus 4.8 and Sonnet 5 on the 2.1 revision, Haiku 4.5 from its 2025-10 launch); Haiku 4.5 SWE-bench Pro is not officially reported.

## When to read this

Read in Stage 5 before assigning a `Tier:` field per step. The plan template's Tier Calibration table is a short summary; this file expands the capability summary and the decision heuristic.

## Tier table

| Model     | ID                        | SWE-bench Verified | SWE-bench Pro | Terminal-Bench | Capability summary |
|-----------|---------------------------|--------------------|---------------|----------------|--------------------|
| Opus 4.8  | claude-opus-4-8           | 88.6%              | 69.2%         | 74.6%          | Frontier long-horizon coding. Holds a real ~6-point SWE-bench Pro lead over Sonnet 5 on the hardest cases and does more self-verification on security-critical logic. Multi-file cross-layer work, architecture, migrations. xhigh effort with adaptive thinking, 1M context. Most expensive; overkill for mechanical or standard pattern work. |
| Sonnet 5  | claude-sonnet-5           | see note           | 63.2%         | 80.4%          | Near-Opus and the default workhorse. Leads Opus 4.8 on Terminal-Bench (80.4% vs 74.6%), sits within a point on HLE and GDPval, trails ~6 points on SWE-bench Pro. Reads broad context, avoids duplicating shared logic, cleaner frontend output, 1M context, roughly 40-60% cheaper than Opus. Standard implementation, pattern-following, refactor-with-pattern, most mid-tier agentic work. The default junior tier. |
| Haiku 4.5 | claude-haiku-4-5-20251001 | 73.3%              | not reported  | 41.75%         | Matches Sonnet 4 at one-third the cost and 4-5x the speed. Fastest with near-frontier intelligence, 200K context. Excels at parallelized execution, sub-agents, and high-volume operations. Mechanical work, config, rename, scaffold, single-file fix, parallel fan-out. |

## Tier decision heuristic

Apply to every step, not just the first. Sonnet 5 is near-Opus and the default workhorse: prefer `junior` and reserve `senior` for genuinely cross-layer, long-horizon, or critical work where Opus 4.8's SWE-bench-Pro-scale edge and extra self-verification pay off. Do not escalate to senior for raw file count alone when the work is standard pattern application Sonnet handles well.

1. How many files, and how coupled? 1 isolated file → quick candidate. A handful of files applying a known pattern → junior; Sonnet 5 reads broad context, so multi-file pattern work is not automatically senior. A genuinely cross-layer or long-horizon change (many coupled modules, architecture, migration) → senior.
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

   If the step touches any of these, escalate the tier by one level: `quick` → `junior`, `junior` → `senior`. On most axes the Sonnet 5 to Opus 4.8 gap is small (Sonnet 5 even leads Terminal-Bench, 80.4% vs 74.6%), but Opus holds a real ~6-point SWE-bench Pro lead on the hardest cases and does more self-verification on security-critical logic, which is exactly where subtle bugs hide. The cost asymmetry justifies the escalation: a bug in auth, payment math, or crypto ships silently and is expensive to find post-deploy, while a senior worker's extra correctness margin is cheap when scoped to the 1-3 critical steps a typical plan carries. This rule applies on TOP of rules 1-4: a quick-by-file-count auth-login step still escalates to junior; a junior-by-default policy rewrite still escalates to senior. Codebase-state escalation (rule 3) and criticality escalation (rule 5) stack.

## Tier-to-worker routing (used by /ac:execute)

| Tier | Worker subagent | Model | Effort |
|---|---|---|---|
| `quick` | `ac:plan-worker-quick` | `claude-haiku-4-5-20251001` | low |
| `junior` | `ac:plan-worker-junior` | `claude-sonnet-5` | medium |
| `senior` | `ac:plan-worker-senior` | `claude-opus-4-8` | high |

`/ac:execute` Phase 1d applies codebase-state escalation: when the plan's `Codebase State` is `legacy` or `chaotic`, every `quick` step is routed to `ac:plan-worker-junior` regardless of the step's declared tier. The plan file is NOT modified by this escalation; it is an in-memory routing decision.

Steps with `Type: verification` skip worker spawn entirely (see the Steps section of `plan-template.md` for the verification step shape). The orchestrator runs the step's `Commands` directly via Bash and captures output to the `Evidence` paths. Per-step 4-layer verification still applies, but Layer A is the orchestrator's direct Bash execution, Layer B is largely n/a (no source files changed), Layer C IS the Evidence file, and Layer D applies. Tier and Why-this-tier are omitted on verification steps; this table does not apply to them.
