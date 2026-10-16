import { compact, runHiddenTest, runTests, share, turn, type Scenario } from "../lib/scenario"

// Three bugs fixed one per turn, with a compaction between turns. Findings from earlier turns matter later.
const HIDDEN = `
import { expect, test } from "bun:test"
import { calc } from "../src/index"

test("decimals", () => {
  expect(calc("1.25 + 0.75")).toBe(2)
  expect(calc("0.5 * 4")).toBe(2)
})

test("right associative powers", () => {
  expect(calc("2 ^ 2 ^ 3")).toBe(256)
  expect(calc("(2 ^ 3) ^ 2")).toBe(64)
})

test("unknown variables", () => {
  expect(() => calc("z * 2")).toThrow("Unknown variable: z")
  expect(calc("a + b", { a: 1, b: 2 })).toBe(3)
})

test("nothing else broke", () => {
  expect(calc("10 - 4 - 3")).toBe(3)
  expect(calc("2 * 3 + 4 * 5")).toBe(26)
  expect(calc("min(4, 2) ^ 3")).toBe(8)
})
`

export const s5: Scenario = {
  id: "S5",
  title: "A debugging session keeps its findings across compactions",
  fixture: "calc",
  steps: [
    turn(
      "Some tests in test/calc.test.ts fail. Investigate every failure, write down the likely cause of each, and fix only the tokenizer problem for now. Run the tests.",
    ),
    compact,
    turn("Fix the next failing test. Don't repeat approaches that already failed."),
    compact,
    turn("Fix whatever still fails and make sure all the tests pass. Then summarize the root cause of each bug."),
  ],
  async check({ workdir }) {
    const tests = await runTests(workdir)
    const hidden = await runHiddenTest(workdir, "s5", HIDDEN)
    const hiddenResults = [...hidden.results.values()]
    const checks = [tests.failed === 0 && tests.passed > 0, ...hiddenResults]
    return {
      success: checks.every(Boolean) && hiddenResults.length === 4,
      score: share(checks),
      violations: 0,
      notes: [
        `tests ${tests.passed} passed, ${tests.failed} failed`,
        ...[...hidden.results].map(([name, passed]) => `${passed ? "ok" : "FAIL"}: ${name}`),
      ],
    }
  },
}
