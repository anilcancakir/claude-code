<!-- ported-from: plugins/ac/skills/project-md-writer/references/example.md sha256:3f688d6aae993a0612f3266343a687639b638f4e64dc47d6059fa40d2530d96e -->
# Example PROJECT.md

An illustrative file for a fictional project, filled to the level of detail the contract asks for. Match its register: short lines, a reason beside every limit, nothing the code already shows.

```markdown
# Invoicer

## What this is

Invoicer is a Laravel API that issues and tracks invoices for small agencies. Agency staff use the web dashboard; accountants pull data through a read-only REST API.

## Core value

An issued invoice is never altered or lost.

## Scope

### Active

- Invoice issue, void and credit note flows
- Payment matching from bank CSV imports
- Read-only REST API for accountants

### Out of scope

- Payment processing: agencies already use their own gateways; revisit when two customers ask for it.
- Multi-currency totals: one currency per invoice only; revisit after the first non-EUR customer.
- Editing an issued invoice: the law requires void and re-issue; not planned.

## Constraints

- **Compliance**: Issued invoices are immutable and numbered without gaps. Why: tax law in the launch market.
- **Stack**: Laravel 12 on PHP 8.4 with PostgreSQL. Why: the hosting contract provides nothing else.
- **Money**: Amounts are integer minor units, never floats. Why: stored totals must match line items exactly.

## Context

- Customers are agencies of 5 to 50 people; the first three are live.
- Bank CSV formats differ per bank; each has its own parser.
- The legacy spreadsheet import drops VAT numbers; do not use it as test data.

## Decisions

| Decision | Why | Rejected alternatives | Status |
|----------|-----|-----------------------|--------|
| Store totals with every invoice | An audit must not depend on recomputation | Compute on read: breaks when rates change | Active |
| Void plus credit note instead of edit | Legal immutability | Soft edit with history: fails the audit rule | Active |

## Where to look

- Architecture: docs/DESIGN.md
- Commands and conventions: AGENTS.md
- Shipped history: CHANGELOG.md

Last reviewed: 2026-10-30 after the accountant API release.
```

What to notice:

- Out of scope lines carry the reason and a revisit condition, so an agent proposing multi-currency finds the answer instead of building it.
- Every constraint ends in a "Why".
- Context lists facts only a person would know (customer size, a bad data source).
- Nothing here repeats the stack's file layout, the test command or the coding style; those live in the code and AGENTS.md.
