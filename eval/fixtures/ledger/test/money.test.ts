import { describe, expect, test } from "bun:test"
import { addCents, fromCents, multiplyCents, splitCents, toCents } from "../src/money"

describe("money", () => {
  test("converts between dollars and cents", () => {
    expect(toCents(12.34)).toBe(1234)
    expect(fromCents(1234)).toBe(12.34)
  })

  test("adds cents", () => {
    expect(addCents(100, 250, 5)).toBe(355)
  })

  test("rounds half away from zero", () => {
    expect(multiplyCents(5, 0.5)).toBe(3)
    expect(multiplyCents(-5, 0.5)).toBe(-3)
  })

  test("splits evenly with the extra cents first", () => {
    expect(splitCents(100, 3)).toEqual([34, 33, 33])
    expect(() => splitCents(100, 0)).toThrow()
  })
})
