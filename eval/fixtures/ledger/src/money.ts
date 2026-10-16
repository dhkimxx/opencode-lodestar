/** Amounts are integer cents, so sums never drift the way floating point dollars do. */
export type Cents = number

export function toCents(amount: number): Cents {
  return Math.round(amount * 100)
}

export function fromCents(cents: Cents): number {
  return cents / 100
}

export function addCents(...values: Cents[]): Cents {
  return values.reduce((sum, value) => sum + value, 0)
}

/** Multiplies and rounds half away from zero, the way the finance team rounds by hand. */
export function multiplyCents(cents: Cents, factor: number): Cents {
  const raw = cents * factor
  return Math.sign(raw) * Math.round(Math.abs(raw))
}

/** Splits an amount into parts that differ by at most one cent. Earlier parts get the extra cents. */
export function splitCents(cents: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts <= 0) throw new Error("parts must be a positive integer")
  const base = Math.floor(cents / parts)
  const remainder = cents - base * parts
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0))
}

export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isInteger(value)
}
