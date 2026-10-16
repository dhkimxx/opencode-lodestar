import { multiplyCents, type Cents } from "./money"

export type Discount = { kind: "percent"; percent: number } | { kind: "fixed"; cents: Cents }

/** Applies a discount and never goes below zero. */
export function applyDiscount(cents: Cents, discount: Discount): Cents {
  if (discount.kind === "percent") {
    if (discount.percent < 0 || discount.percent > 100) throw new Error("percent must be between 0 and 100")
    return cents - multiplyCents(cents, discount.percent / 100)
  }
  if (discount.cents < 0) throw new Error("a fixed discount can't be negative")
  return Math.max(0, cents - discount.cents)
}

export function describeDiscount(discount: Discount): string {
  return discount.kind === "percent" ? `${discount.percent}% off` : `${discount.cents} cents off`
}
