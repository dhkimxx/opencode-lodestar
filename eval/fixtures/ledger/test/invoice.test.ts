import { describe, expect, test } from "bun:test"
import { invoiceTotals, lineTotal, type Invoice } from "../src/invoice"
import { applyTax, taxRate } from "../src/tax"

const invoice: Invoice = {
  id: "INV-1",
  customer: "Acme",
  region: "US-CA",
  lines: [
    { sku: "PEN", description: "Pen", unitCents: 150, quantity: 4 },
    { sku: "PAD", description: "Notepad", unitCents: 325, quantity: 2 },
  ],
}

describe("invoice", () => {
  test("totals lines", () => {
    expect(lineTotal({ sku: "X", description: "", unitCents: 199, quantity: 3 })).toBe(597)
  })

  test("applies tax after the discount", () => {
    expect(invoiceTotals(invoice)).toEqual({ subtotal: 1250, discount: 0, tax: 91, total: 1341 })
    const discounted = invoiceTotals({ ...invoice, discount: { kind: "percent", percent: 10 } })
    expect(discounted).toEqual({ subtotal: 1250, discount: 125, tax: 82, total: 1207 })
  })

  test("looks up tax rates", () => {
    expect(taxRate("CA-ON")).toBe(0.13)
    expect(applyTax(1000, "US-NY")).toBe(1040)
  })
})
