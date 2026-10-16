import { applyDiscount, type Discount } from "./discount"
import { addCents, multiplyCents, type Cents } from "./money"
import { taxAmount, type Region } from "./tax"

export interface InvoiceLine {
  sku: string
  description: string
  unitCents: Cents
  quantity: number
}

export interface Invoice {
  id: string
  customer: string
  region: Region
  lines: InvoiceLine[]
  discount?: Discount
}

export interface InvoiceTotals {
  subtotal: Cents
  discount: Cents
  tax: Cents
  total: Cents
}

export function lineTotal(line: InvoiceLine): Cents {
  if (!Number.isInteger(line.quantity) || line.quantity < 0) throw new Error(`bad quantity for ${line.sku}`)
  return multiplyCents(line.unitCents, line.quantity)
}

export function subtotal(invoice: Invoice): Cents {
  return addCents(...invoice.lines.map(lineTotal))
}

/** Discounts apply before tax. */
export function invoiceTotals(invoice: Invoice): InvoiceTotals {
  const sub = subtotal(invoice)
  const discounted = invoice.discount ? applyDiscount(sub, invoice.discount) : sub
  const tax = taxAmount(discounted, invoice.region)
  return { subtotal: sub, discount: sub - discounted, tax, total: discounted + tax }
}
