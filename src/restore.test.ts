import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordTool } from "./files"
import { buildRestoration, describeRestoration, restoreBudget, summaryFromCheckpoint, summaryKeyOf } from "./restore"
import type { SessionState } from "./state"

let dir = ""
const state = (): SessionState => ({ directory: dir, files: {}, notes: [], todo: [], skills: {}, toolStreak: 0, recited: false })

async function file(name: string, text: string, ageSeconds: number) {
  const target = path.join(dir, name)
  await writeFile(target, text)
  const time = Date.now() / 1000 - ageSeconds
  await utimes(target, time, time)
  return target
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lodestar-restore-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("restoreBudget", () => {
  test("stays within its bounds", () => {
    expect(restoreBudget(undefined, 1_000_000)).toBe(10_000)
    expect(restoreBudget(60_000, 1_000_000)).toBe(12_000)
    expect(restoreBudget(900_000, 1_000_000)).toBe(40_000)
    expect(restoreBudget(900_000, 100_000)).toBe(20_000)
  })
})

describe("buildRestoration", () => {
  test("restores the five most recently changed files that the session used", async () => {
    const session = state()
    for (let index = 0; index < 7; index++) {
      const name = `f${index}.ts`
      await file(name, `export const value${index} = ${index}\n`, 100 - index)
      await recordTool(session, { tool: "read", input: { path: name }, output: undefined, directory: dir, now: index })
    }
    const restoration = await buildRestoration(session, 1_000_000, "key")
    expect(restoration?.files).toBe(5)
    expect(restoration?.text).toContain('<file path="f6.ts">')
    expect(restoration?.text).toContain("1: export const value6 = 6")
    expect(restoration?.text).not.toContain('<file path="f1.ts">')
  })

  test("refers to a file that is too large instead of restoring it", async () => {
    const session = state()
    await file("big.ts", "x".repeat(30_000), 1)
    await recordTool(session, { tool: "read", input: { path: "big.ts" }, output: undefined, directory: dir, now: 1 })
    const restoration = await buildRestoration(session, 1_000_000, "key")
    expect(restoration?.files).toBe(0)
    expect(restoration?.references).toBe(1)
    expect(restoration?.text).toContain('restored="no"')
  })

  test("puts the todo list, notes, and skills back, newest skill first", async () => {
    const session = state()
    session.todo = [
      { text: "write tests", status: "done" },
      { text: "fix the parser", status: "in_progress" },
    ]
    session.notes = ["The tokenizer handles decimals now."]
    session.skills = {
      old: { name: "old", text: "Old skill body", at: 1 },
      new: { name: "new", text: "New skill body", at: 2 },
    }
    const restoration = await buildRestoration(session, 1_000_000, "key")
    const text = restoration?.text ?? ""
    expect(text).toContain("- [x] write tests")
    expect(text).toContain("- [~] fix the parser")
    expect(text).toContain("The tokenizer handles decimals now.")
    expect(text.indexOf('<skill name="new">')).toBeLessThan(text.indexOf('<skill name="old">'))
    expect(restoration && describeRestoration(restoration)).toBe("lodestar restored the todo list, 2 skills after compaction (~1k tokens).")
  })

  test("returns nothing when there is nothing to restore", async () => {
    expect(await buildRestoration(state(), 1_000_000, "key")).toBeUndefined()
  })
})

test("summaryFromCheckpoint reads the summary out of OpenCode's checkpoint message", () => {
  const checkpoint = "<conversation-checkpoint>\nnote\n\n<summary>\n## Objective\n- fix it\n</summary>\n</conversation-checkpoint>"
  expect(summaryFromCheckpoint(checkpoint)).toBe("## Objective\n- fix it")
})

test("summaries that share an opening still get different keys", () => {
  const opening = "## User requests\n" + "x".repeat(400)
  expect(summaryKeyOf(`${opening}\nfirst`)).not.toBe(summaryKeyOf(`${opening}\nsecond`))
  expect(summaryKeyOf(" same ")).toBe(summaryKeyOf("same"))
})
