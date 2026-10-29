import { expect, test } from "bun:test"
import { promptTokens } from "./tokens"

test("counts a step's prompt as new input plus cache reads and writes", () => {
  expect(promptTokens({ input: 1_200, output: 300, reasoning: 0, cache: { read: 30_000, write: 800 } })).toBe(32_000)
  expect(promptTokens({ input: 500 })).toBe(500)
  expect(promptTokens(undefined)).toBeUndefined()
  expect(promptTokens({ cache: { read: 10 } })).toBeUndefined()
})
