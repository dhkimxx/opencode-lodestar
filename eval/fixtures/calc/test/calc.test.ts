import { describe, expect, test } from "bun:test"
import { calc } from "../src"

describe("calc", () => {
  test("respects precedence", () => {
    expect(calc("1 + 2 * 3")).toBe(7)
    expect(calc("(1 + 2) * 3")).toBe(9)
  })

  test("reads decimals", () => {
    expect(calc("3.5 * 2")).toBe(7)
  })

  test("treats ^ as right associative", () => {
    expect(calc("2 ^ 3 ^ 2")).toBe(512)
  })

  test("negates", () => {
    expect(calc("-4 + 10")).toBe(6)
  })

  test("uses variables", () => {
    expect(calc("x * 2", { x: 21 })).toBe(42)
  })

  test("rejects unknown variables", () => {
    expect(() => calc("y + 1")).toThrow("Unknown variable: y")
  })

  test("calls functions", () => {
    expect(calc("max(1, 5, 3)")).toBe(5)
    expect(calc("sqrt(16) + abs(-2)")).toBe(6)
  })

  test("rejects division by zero", () => {
    expect(() => calc("1 / (2 - 2)")).toThrow("Division by zero")
  })

  test("rejects unexpected characters", () => {
    expect(() => calc("2 $ 3")).toThrow("Unexpected character")
  })
})
