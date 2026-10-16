import path from "node:path"
import { runHiddenTest, runTests, share, turn, type Scenario } from "../lib/scenario"

// The user edits a file the agent already read. The next request touches the same function.
const USER_TAX = `import { multiplyCents, type Cents } from "./money"

export type Region = "US-CA" | "US-NY" | "US-TX" | "CA-ON" | "EU-DE"

export const TAX_RATES: Record<Region, number> = {
  "US-CA": 0.0725,
  "US-NY": 0.04,
  "US-TX": 0.0625,
  "CA-ON": 0.13,
  "EU-DE": 0.19,
}

export function taxRate(region: Region): number {
  // Finance asked for an explicit lookup so new regions are easy to spot in review.
  const rate = TAX_RATES[region]
  return rate
}

export function taxAmount(cents: Cents, region: Region): Cents {
  return multiplyCents(cents, taxRate(region))
}

export function applyTax(cents: Cents, region: Region): Cents {
  return cents + taxAmount(cents, region)
}
`

const HIDDEN = `
import { expect, test } from "bun:test"
import { invoiceTotals } from "../src/invoice"
import { taxRate } from "../src/tax"

const invoice = {
  id: "INV-1",
  customer: "Acme",
  region: "US-CA" as const,
  lines: [{ sku: "PEN", description: "Pen", unitCents: 1000, quantity: 1 }],
}

test("exempt invoices have no tax", () => {
  const totals = invoiceTotals({ ...invoice, taxExempt: true } as never)
  expect(totals.tax).toBe(0)
  expect(totals.total).toBe(1000)
  expect(invoiceTotals(invoice).tax).toBe(73)
})

test("unknown regions throw", () => {
  expect(() => taxRate("XX-YY" as never)).toThrow("Unknown region: XX-YY")
})

test("the user's new region still works", () => {
  expect(taxRate("EU-DE" as never)).toBe(0.19)
})
`

export const s4: Scenario = {
  id: "S4",
  title: "A file the user changed mid-task is re-read, not overwritten",
  fixture: "ledger",
  steps: [
    turn(
      "Read src/tax.ts and src/invoice.ts. Then add support for tax-exempt customers: Invoice gets an optional taxExempt?: boolean, and an exempt invoice has zero tax. Add a test for it and run the tests.",
    ),
    {
      kind: "edit",
      note: "the user edits src/tax.ts in their own editor",
      apply: (workdir) => Bun.write(path.join(workdir, "src/tax.ts"), USER_TAX).then(() => undefined),
    },
    turn(
      'Make taxRate in src/tax.ts throw an Error with the message "Unknown region: <code>" when the region isn\'t in TAX_RATES, and add a test for it. Run the tests.',
    ),
  ],
  async check({ workdir }) {
    const tests = await runTests(workdir)
    const tax = await Bun.file(path.join(workdir, "src/tax.ts")).text()
    const userKept = tax.includes('"EU-DE": 0.19') && tax.includes("Finance asked for an explicit lookup")
    const hidden = await runHiddenTest(workdir, "s4", HIDDEN)
    const hiddenResults = [...hidden.results.values()]
    const checks = [tests.failed === 0 && tests.passed > 0, userKept, ...hiddenResults]
    return {
      success: checks.every(Boolean) && hiddenResults.length === 3,
      score: share(checks),
      violations: Number(!userKept),
      notes: [
        `tests ${tests.passed} passed, ${tests.failed} failed`,
        `user's edit ${userKept ? "kept" : "LOST"}`,
        ...[...hidden.results].map(([name, passed]) => `${passed ? "ok" : "FAIL"}: ${name}`),
      ],
    }
  },
}
