import { compact, runHiddenTest, runTests, share, turn, type Scenario } from "../lib/scenario"

// A six-item plan given once, carried out across three turns with a compaction between each.
const PLAN = [
  "Here is the plan for this session. Keep track of it, because I'll ask you to continue in later messages.",
  "",
  '1. Add slugify(text: string): string to src/strings.ts. Lowercase the text, replace every run of characters that are not a-z or 0-9 with a single "-", and trim "-" from both ends. "  Hello, World!  " becomes "hello-world".',
  '2. Add truncate(text: string, max: number): string to src/strings.ts. If the text is longer than max, cut it and end it with "…" so the result is exactly max characters long. "hello world" with max 8 becomes "hello w…". Shorter text comes back unchanged.',
  "3. Rename capitalizeWords to titleCase everywhere. Keep capitalizeWords exported as an alias of titleCase, with a @deprecated JSDoc comment.",
  "4. Add wordCount(text: string): number to src/strings.ts. It counts words separated by any whitespace. An empty or blank string has 0 words.",
  '5. Fix reverseWords so punctuation stays attached to its word: "hello, world!" becomes "world! hello,".',
  "6. Update the API section of README.md so it lists every exported function with a one-line description.",
  "",
  "Export every new function from src/index.ts and add tests for each item. Do items 1 and 2 now and run the tests.",
].join("\n")

const HIDDEN = `
import { expect, test } from "bun:test"
import * as kit from "../src/index"
import * as strings from "../src/strings"

const fn = (name: string) => (kit as Record<string, unknown>)[name] as (...args: unknown[]) => unknown

test("item 1 slugify", () => {
  expect(fn("slugify")("  Hello, World!  ")).toBe("hello-world")
  expect(fn("slugify")("A  B--C")).toBe("a-b-c")
})

test("item 2 truncate", () => {
  expect(fn("truncate")("hello world", 8)).toBe("hello w…")
  expect(fn("truncate")("hi", 5)).toBe("hi")
})

test("item 3 titleCase", async () => {
  expect(fn("titleCase")("hello big world")).toBe("Hello Big World")
  const alias = (strings as Record<string, unknown>).capitalizeWords as (text: string) => string
  expect(alias("hello big world")).toBe("Hello Big World")
  expect(await Bun.file(new URL("../src/strings.ts", import.meta.url)).text()).toContain("@deprecated")
  expect(await Bun.file(new URL("../src/format.ts", import.meta.url)).text()).not.toContain("capitalizeWords")
})

test("item 4 wordCount", () => {
  expect(fn("wordCount")("  a b\\tc\\n d ")).toBe(4)
  expect(fn("wordCount")("")).toBe(0)
  expect(fn("wordCount")("   ")).toBe(0)
})

test("item 5 reverseWords", () => {
  expect(strings.reverseWords("hello, world!")).toBe("world! hello,")
  expect(strings.reverseWords("one two three")).toBe("three two one")
})

test("item 6 README", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text()
  for (const name of ["slugify", "truncate", "titleCase", "wordCount"]) expect(readme).toContain(name)
})
`

export const s3: Scenario = {
  id: "S3",
  title: "A six-item plan survives two compactions",
  fixture: "textkit",
  steps: [
    turn(PLAN),
    compact,
    turn("Continue with the next two items of the plan."),
    compact,
    turn("Finish the remaining items of the plan, run the tests, and then list every item with its status."),
  ],
  async check({ workdir }) {
    const tests = await runTests(workdir)
    const hidden = await runHiddenTest(workdir, "s3", HIDDEN)
    const items = [1, 2, 3, 4, 5, 6].map((item) =>
      [...hidden.results].some(([name, passed]) => passed && name.startsWith(`item ${item} `)),
    )
    const testsPass = tests.failed === 0 && tests.passed > 0
    return {
      success: testsPass && items.every(Boolean),
      score: share(items),
      violations: 0,
      notes: [
        `tests ${tests.passed} passed, ${tests.failed} failed`,
        `items done: ${items.map((done, index) => (done ? index + 1 : "-")).join(" ")}`,
      ],
    }
  },
}
