// Owned by the billing-platform team, which ships this file to other services too.
// Older reports depend on its exact output, so it stays as it is.
import type { Cents } from "../money"

export function formatCurrency(cents: Cents, symbol = "$"): string {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, "0")
  return `${sign}${symbol}${whole}.${fraction}`
}

export function parseCurrency(text: string): Cents {
  const match = text.trim().match(/^(-)?\$?(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) throw new Error(`not a currency amount: ${text}`)
  const [, minus, whole, fraction = "0"] = match
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return minus ? -cents : cents
}
