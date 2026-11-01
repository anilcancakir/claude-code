# Example ARCHITECTURE.md

An illustrative file for a fictional project, filled to the level of detail the contract asks for. Match its register: boundaries and absences instead of file lists, symbols instead of line numbers, a verify entry beside every invariant, and nothing the code already shows.

````markdown
# Invoicer architecture

## Overview

Invoices are immutable once issued; corrections are new records. Services own every business rule: controllers and the read-only API hold none. The read API bypasses services on purpose and reads through query objects, so a rule added to a service does not reach it.

## Codemap

### `app/Services/Invoicing/`

- Owns: issuing, voiding and crediting invoices.
- Must not: read the clock or the request; callers pass both in.
- Depends on: Numbering, Repositories

### `app/Services/Numbering/`

- Owns: gapless invoice numbers.
- Must not: be called outside an open transaction.
- Depends on: Repositories

### `app/Services/BankImport/`

- Owns: parsing CSV exports into payment candidates and matching them to invoices.
- Must not: write; a parser returns candidates and a user confirms the match.
- Depends on: Invoicing (read only)

## Invariants

| Rule | Why | Verify |
|------|-----|--------|
| No UPDATE on an issued invoice | Legal immutability | `tests/Feature/ImmutabilityTest.php` |
| Invoice numbers have no gaps | Tax law | `tests/Unit/NumberingServiceTest.php` |
| Controllers never call repositories | Rules live in services | `composer arch` (deptrac) |

## Flows

Issue an invoice:

1. `app/Http/Controllers/InvoiceController.php:store` validates through `app/Http/Requests/IssueInvoiceRequest.php`.
2. `app/Services/Invoicing/InvoiceService.php:issue` takes the next number from `app/Services/Numbering/NumberingService.php:next` inside one transaction.
3. `app/Repositories/InvoiceRepository.php:insert` stores the invoice, its lines and the computed totals.

## Decisions

| Decision | Why | Rejected alternatives | Status |
|----------|-----|-----------------------|--------|
| Take the number inside the issue transaction | A rollback must release it | Database sequence: leaves gaps | Active |
| Read API uses query objects, not services | Keeps reads free of write rules | Reuse services: couples the API to write paths | Active |

## Change guide

| To change | Touch | Also check |
|-----------|-------|------------|
| Add a bank | New class implementing `BankParser`, register it in `BankImportServiceProvider` | fixture CSV and parser test |
| Add an invoice field | migration, `Invoice` model, `IssueInvoiceRequest`, API resource | `ImmutabilityTest` |

## Cross-cutting

- Errors: services throw domain exceptions such as `InvoiceAlreadyIssued`; `app/Exceptions/Handler.php` maps them to 409 or 422.
- Money: integer minor units everywhere; a float in a money path is a bug.
- Testing: feature tests per route; unit tests per parser with fixture CSVs in `tests/fixtures/bank/`.

## Traps

- `InvoiceRepository::insert` also writes lines; there is no separate line repository.
- Query objects read from the primary database; the replica split is not wired: `config/database.php`.

Last reviewed: 2026-10-30 after the credit note milestone.
````

What to notice:

- The Overview holds the two facts the directory names do not show (immutability, and the read API bypassing services); the layer diagram a reader could draw from the folders is left out.
- The Codemap says what each module may not do. The directory tree and the class list are left to the code.
- The Change guide is written from real tasks, so an agent adding a bank finds the two places to edit.
- Each invariant names the test or command that proves it, so an audit can run it.
- Traps record the two places where reading the code would send a newcomer the wrong way.
