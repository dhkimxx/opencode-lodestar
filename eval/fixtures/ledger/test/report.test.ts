import { describe, expect, test } from "bun:test"
import type { Invoice } from "../src/invoice"
import { renderInvoice } from "../src/report"

const invoice: Invoice = {
  id: "INV-7",
  customer: "Globex",
  region: "US-TX",
  lines: [{ sku: "DESK", description: "Desk", unitCents: 24900, quantity: 1 }],
}

describe("report", () => {
  test("renders the header and totals", () => {
    const text = renderInvoice(invoice)
    expect(text).toContain("Invoice INV-7 for Globex")
    expect(text).toContain("Subtotal: $249.00")
    expect(text).toContain("Tax (US-TX): $15.56")
    expect(text).toContain("Total: $264.56")
  })

  test("shows a discount line only when there is a discount", () => {
    expect(renderInvoice(invoice)).not.toContain("Discount")
    expect(renderInvoice({ ...invoice, discount: { kind: "fixed", cents: 900 } })).toContain("Discount: -$9.00")
  })
})
