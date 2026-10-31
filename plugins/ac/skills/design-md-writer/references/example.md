# Example DESIGN.md

An illustrative file for a fictional project, filled to the level of detail the contract asks for. Match its register: responsibilities and boundaries, symbols instead of line numbers, a verify entry beside every invariant.

````markdown
# Invoicer design

## Overview

Requests enter through HTTP controllers, which call application services. Services own every business rule and write through repositories. Invoices are immutable once issued; corrections are new records.

```text
HTTP controllers -> Services -> Repositories -> PostgreSQL
                       |
                       +-> Bank import parsers (one per bank)
Read-only API -------> Query objects --------> PostgreSQL
```

## Components

### Invoicing

- Location: `app/Services/Invoicing/`
- Responsibility: issue, void and credit invoices.
- Depends on: Numbering, Repositories

### Numbering

- Location: `app/Services/Numbering/`
- Responsibility: hand out gapless invoice numbers.
- Depends on: Repositories

### Bank import

- Location: `app/Services/BankImport/`
- Responsibility: parse CSV exports into payment candidates and match them to invoices.
- Depends on: Invoicing (read only), Repositories
- Invariants: a parser never writes; matching proposes and a user confirms.

## Data flow

Issue an invoice:

1. `app/Http/Controllers/InvoiceController.php:store` validates through `app/Http/Requests/IssueInvoiceRequest.php`.
2. `app/Services/Invoicing/InvoiceService.php:issue` takes the next number from `app/Services/Numbering/NumberingService.php:next` inside one transaction.
3. `app/Repositories/InvoiceRepository.php:insert` stores the invoice, its lines and the computed totals.

## Data model

- `invoices`, `invoice_lines`, `credit_notes`: schema in `database/migrations/`; amounts are integer minor units.
- A credit note references exactly one invoice; an invoice has many credit notes.

## Interfaces

- Accountant API: routes in `routes/api.php`, read only, versioned under `/v1`.
- Bank parsers implement `BankParser`; adding a bank means adding one class.

## Invariants

| Rule | Why | How to verify |
|------|-----|---------------|
| No UPDATE on an issued invoice | Legal immutability | `tests/Feature/ImmutabilityTest.php` |
| Invoice numbers have no gaps | Tax law | `tests/Unit/NumberingServiceTest.php` |

## Decisions

| Decision | Why | Rejected alternatives | Status |
|----------|-----|-----------------------|--------|
| Take the number inside the issue transaction | A rollback must release it | Database sequence: leaves gaps | Active |
| Read API uses query objects, not services | Keeps reads free of write rules | Reuse services: couples the API to write paths | Active |

## Errors and testing

- Errors: services throw domain exceptions such as `InvoiceAlreadyIssued`; `app/Exceptions/Handler.php` maps them to 409 or 422.
- Tests: feature tests per route; unit tests per parser with fixture CSVs in `tests/fixtures/bank/`.

## Change guide

| To change | Touch | Also check |
|-----------|-------|------------|
| Add a bank | New class implementing `BankParser`, register it in `BankImportServiceProvider` | fixture CSV and parser test |
| Add an invoice field | migration, `Invoice` model, `IssueInvoiceRequest`, API resource | `ImmutabilityTest` |

## Known gaps

- Query objects read from the primary database; the replica split is not wired: `config/database.php`.

Last reviewed: 2026-10-30 after the credit note milestone.
````

What to notice:

- Components say what each part owns and may touch; the file tree is left to the code.
- The Change guide is written from real tasks, so an agent adding a bank finds the two places to edit.
- Each invariant names the test that proves it, so an audit can run it.
