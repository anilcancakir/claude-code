# Code Review Core

Both post-implementation code reviewers read this file in full and run every stage in it, on every review, without exception or condition. Stages beyond Stage 4 and the verdict rule belong to the reading agent, not to this file.

## Execution

1. Read the plan file. Identify each step's `Done when:` criterion, the `## Must NOT Have` section, the acceptance criteria in `## Work Objectives`, the `## Codebase Conventions`, and the `## Reuse Map`.
2. Read every modified file from the input list.
3. Run Stage 1 (compliance), then Stage 2 (spec), then Stage 3 (quality), then Stage 4 (simplify). Stages are sequential; do not interleave findings.
4. Apply every check to every step and every modified file, not a sample.

### Severity and confidence

Applies to Stage 3 and Stage 4. Rate each finding: severity (CRITICAL / IMPORTANT / MINOR), confidence (0-100). Only report CRITICAL and IMPORTANT with confidence 50 or above. Tag any finding whose confidence is under 80 with `[confidence: N]`. MINOR-severity findings are not reported, and confidence under 50 is not reported. The point is to surface real issues, not pad the report.

### Stage 1: Compliance

For each step's `Done when:` criterion, verify the claim against the codebase using L1 / L2 / L3 levels.

| Level | Name | Check | Skip when |
|-------|------|-------|-----------|
| L1 | Exists | File exists, non-empty, expected identifiers present (Glob + Read) | Never |
| L2 | Substantive | No stubs: grep for `TODO`, `FIXME`, `not implemented`, empty bodies, `pass`, `raise NotImplementedError`, `throw new Error('TODO')` | Never |
| L3 | Wired | At least one import/require/use of the file or its exports (LSP `findReferences` or Grep) | Config files, test files, scripts, entry points |

Verification stops at the first failure: L1 fail gives UNMET, L2 fail gives UNMET (stub), L3 fail gives UNMET (unwired). All three pass gives MET.

**Must NOT Have**: For each forbidden pattern in the plan's `## Must NOT Have` section, search the modified files. Report any match with `file_path:line_number`. Each violation is a separate finding.

**Scope Fidelity**: For each file the plan declared to modify, verify it was actually modified. Flag files NOT in the plan that appear in the modified files list; that is scope creep.

Stage 1 failure is always CRITICAL.

### Stage 2: Spec Compliance

For each acceptance criterion in the plan's `## Work Objectives` (Definition of Done bullets, Concrete Deliverables):

1. Grep / Read the relevant files to verify the implementation provides the claimed behavior.
2. Report PASS with brief `file_path:line_number` evidence, or FAIL with what is missing and where.

Stage 2 failures are always CRITICAL. Stop once all acceptance criteria are checked; do not expand scope to criteria the plan did not list.

### Stage 3: Code Quality

Check the modified files for:

- **Logic errors**: wrong conditions, off-by-one, unreachable branches, swapped argument order.
- **Null / undefined handling**: missing guards given the actual data flow in the file.
- **Anti-patterns**: duplicated logic, misleading names, hidden early returns, stringly-typed code where a type/enum exists.
- **my-coding rule violations** (your context has `my-coding` preloaded): scan each modified file against my-coding's rules. Cite the specific rule for every violation.
- **Missing error handling**: for operations that genuinely fail in production (I/O, network, parsing). Boundary code without error handling is a finding; pure internal pure-function code without error handling is not.

### Stage 4: Simplify

The simplify pass is plan-time `simplify` skill semantics applied post-implementation. Three axes against the actual code.

#### 4.1 Code Reuse

For each new function, type, or abstraction created during execution:

- Cross-check against the plan's `## Reuse Map`. If a Reuse Map entry solves the same problem, flag as `REUSE OPPORTUNITY MISSED: <new thing at file:line> -> <Reuse Map entry at file:line>`.
- For new functions: grep the codebase (outside the modified files) for similar shapes the worker should have reused. Flag missed reuse with the existing utility's `file:line`.

#### 4.2 Quality patterns

Scan modified files for these patterns:

- Redundant state (two fields holding derivable info).
- Parameter sprawl (functions with 5+ unrelated parameters).
- Copy-paste with slight variation (two nearly-identical blocks differing in 1-2 lines).
- Leaky abstractions (internal types exposed in public API).
- Stringly-typed code where the codebase has a type or enum.
- Unnecessary comments (comments restating what the code says, no WHY).

#### 4.3 Efficiency

Scan modified files for:

- Unnecessary work (computing a value never read, redundant traversal).
- Missed concurrency (sequential awaits that could be `Promise.all`).
- Hot-path bloat (heavy operation inside a tight loop when it could be hoisted).
- No-op updates (writing the same value, calling a setter without state change).

## Output format

Report Stages 1 through 4 in exactly this shape, with no preamble. The reading agent appends its own later stages and its own verdict block after this.

```markdown
## Stage 1: Compliance

| # | Step | Criterion | L1 | L2 | L3 | Status | Evidence | Fingerprint |
|---|------|-----------|----|----|----|--------|----------|-------------|
| 1 | <step> | <criterion> | OK | OK | OK | MET | `file:line` | |
| 2 | <step> | <criterion> | OK | NO | -- | UNMET (stub) | `file:line` | `compliance\|S2` |

**Must NOT Have**: <CLEAN | N violations with file:line list>
**Scope Fidelity**: <CLEAN | N unplanned files changed>
**Compliance**: <M/N met>

## Stage 2: Spec Compliance

| Criterion | Status | Evidence | Fingerprint |
|-----------|--------|----------|-------------|
| <criterion> | PASS | `file:line` | |
| <criterion> | FAIL | <what is missing> | `spec\|<criterion-id>` |

**Spec**: <N/M criteria pass>

## Stage 3: Code Quality

### CRITICAL
- `file:line`: <issue>. <Why it matters.> Fix: <concrete change>. <my-coding rule cite if applicable.> [confidence: N if < 80]
  Fingerprint: `quality|<file:line>`

### IMPORTANT
- `file:line`: <issue>. <Why it matters.> Fix: <concrete change>. [confidence: N if < 80]
  Fingerprint: `quality|<file:line>`

## Stage 4: Simplify

### Code Reuse (CRITICAL / IMPORTANT)
- REUSE OPPORTUNITY MISSED: <new thing at file:line> -> <Reuse Map entry or sibling utility at file:line>. Fix: <replace with the existing utility>.
  Fingerprint: `simplify|<file:line>`

### Quality Patterns (CRITICAL / IMPORTANT)
- `file:line`: <pattern, for example parameter sprawl>. Fix: <concrete change>.

### Efficiency (CRITICAL / IMPORTANT)
- `file:line`: <issue>. Fix: <concrete change>.
```

Match the language of the plan content for prose. Verdict markers (`APPROVED` / `BLOCKED`), severity tags, status values (MET / UNMET / PASS / FAIL / CLEAN), section headers, and L1/L2/L3 labels stay in English for downstream parsing.

## Fingerprint

Every reported finding carries a fingerprint, so the orchestrator can tell a pass that found new problems from one
repeating itself. The form is `<check>|<anchor>`, always that separator and nothing else: a pass emitting
`compliance|S6` followed by one emitting `compliance - S6` reads as a brand-new finding, the new-finding count never
reaches zero, and the stall test never fires.

`<check>` comes from a closed set that always includes `compliance`, `spec`, `quality`, and `simplify`; the reading
agent lists any values it adds. `<anchor>` is the step id or `file:line` the finding already cites. In the Stage 1
and Stage 2 tables the fingerprint is the last column, filled only on a failing row. Under Stage 3 and Stage 4 it is
an indented sub-bullet directly beneath the finding.
