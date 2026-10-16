import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordTool } from "./files"
import { recitation, staleFiles, staleNotice } from "./reminders"
import type { SessionState } from "./state"

let dir = ""
const state = (): SessionState => ({ directory: dir, files: {}, notes: [], skills: {}, toolStreak: 0, recited: false })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lodestar-reminders-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("asks for a recap after eight tool calls, once per run", () => {
  const session = state()
  session.toolStreak = 7
  expect(recitation(session)).toBeUndefined()
  session.toolStreak = 8
  expect(recitation(session)).toContain("8 tool calls since you last wrote to the user")
  session.recited = true
  expect(recitation(session)).toBeUndefined()
})

test("reports a file changed on disk once, and again only after another change", async () => {
  const session = state()
  const target = path.join(dir, "tax.ts")
  await writeFile(target, "one")
  await recordTool(session, { tool: "read", input: { path: "tax.ts" }, output: undefined, directory: dir, now: 1 })
  expect(await staleFiles(session)).toEqual({ changed: [], deleted: [] })

  await writeFile(target, "two, longer")
  const first = await staleFiles(session)
  expect(first.changed).toEqual([target])
  expect(staleNotice(session, first)).toContain("tax.ts")
  expect((await staleFiles(session)).changed).toEqual([])

  await recordTool(session, { tool: "read", input: { path: target }, output: undefined, directory: dir, now: 2 })
  await unlink(target)
  expect(await staleFiles(session)).toEqual({ changed: [], deleted: [target] })
})

test("the agent's own edits don't count as outside changes", async () => {
  const session = state()
  const target = path.join(dir, "a.ts")
  await writeFile(target, "one")
  await recordTool(session, { tool: "read", input: { path: "a.ts" }, output: undefined, directory: dir, now: 1 })
  await writeFile(target, "edited by the agent")
  await recordTool(session, { tool: "edit", input: { path: "a.ts" }, output: undefined, directory: dir, now: 2 })
  expect(await staleFiles(session)).toEqual({ changed: [], deleted: [] })
})
