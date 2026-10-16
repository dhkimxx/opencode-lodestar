import { describe, expect, test } from "bun:test"
import { banner, formatName } from "../src/format"
import { capitalizeWords, countVowels, padCenter, reverseWords } from "../src/strings"

describe("strings", () => {
  test("capitalizes words", () => {
    expect(capitalizeWords("hello big world")).toBe("Hello Big World")
  })

  test("reverses plain words", () => {
    expect(reverseWords("one two three")).toBe("three two one")
  })

  test("centers text", () => {
    expect(padCenter("ab", 6, "*")).toBe("**ab**")
    expect(padCenter("ab", 5)).toBe(" ab  ")
  })

  test("counts vowels", () => {
    expect(countVowels("Education")).toBe(5)
  })
})

describe("format", () => {
  test("formats names", () => {
    expect(formatName("  ada   lovelace ")).toBe("Ada Lovelace")
  })

  test("draws a banner", () => {
    expect(banner("hi", 6)).toBe("======\n  Hi  \n======")
  })
})
