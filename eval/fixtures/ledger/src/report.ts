import { formatCurrency } from "./legacy/currency"
import { invoiceTotals, lineTotal, type Invoice } from "./invoice"

export function renderInvoice(invoice: Invoice): string {
  const lines = invoice.lines.map(
    (line) =>
      `${line.sku.padEnd(10)} ${String(line.quantity).padStart(3)} x ${formatCurrency(line.unitCents).padStart(10)} = ${formatCurrency(lineTotal(line)).padStart(12)}`,
  )
  const totals = invoiceTotals(invoice)
  return [
    `Invoice ${invoice.id} for ${invoice.customer}`,
    ...lines,
    `Subtotal: ${formatCurrency(totals.subtotal)}`,
    ...(totals.discount > 0 ? [`Discount: -${formatCurrency(totals.discount)}`] : []),
    `Tax (${invoice.region}): ${formatCurrency(totals.tax)}`,
    `Total: ${formatCurrency(totals.total)}`,
  ].join("\n")
}
