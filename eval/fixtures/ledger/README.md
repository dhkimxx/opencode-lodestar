# ledger

Small invoicing library. Money is stored in integer cents.

- `src/money.ts`: cents arithmetic.
- `src/tax.ts`: tax rates by region.
- `src/discount.ts`: percent and fixed discounts.
- `src/invoice.ts`: invoice lines and totals.
- `src/report.ts`: plain-text invoice reports.
- `src/legacy/`: older helpers kept for existing reports.

Run the tests with `bun test`.
