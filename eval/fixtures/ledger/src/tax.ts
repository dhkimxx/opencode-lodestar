import { multiplyCents, type Cents } from "./money"

export type Region = "US-CA" | "US-NY" | "US-TX" | "CA-ON"

export const TAX_RATES: Record<Region, number> = {
  "US-CA": 0.0725,
  "US-NY": 0.04,
  "US-TX": 0.0625,
  "CA-ON": 0.13,
}

export function taxRate(region: Region): number {
  return TAX_RATES[region]
}

export function taxAmount(cents: Cents, region: Region): Cents {
  return multiplyCents(cents, taxRate(region))
}

export function applyTax(cents: Cents, region: Region): Cents {
  return cents + taxAmount(cents, region)
}
