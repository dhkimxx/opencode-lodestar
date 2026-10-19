import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordShellRun, recordTool } from "./files"
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

test("a change made while the agent's own shell command ran isn't reported", async () => {
  const session = state()
  const target = path.join(dir, "a.ts")
  await writeFile(target, "one")
  await recordTool(session, { tool: "read", input: { path: "a.ts" }, output: undefined, directory: dir, now: 1 })
  const start = Date.now()
  await writeFile(target, "reformatted by the agent's own command")
  recordShellRun(session, start, Date.now())
  expect(await staleFiles(session)).toEqual({ changed: [], deleted: [] })

  // A later change, outside any of the agent's commands, is someone else's.
  await writeFile(target, "changed by the user afterwards")
  const later = new Date(Date.now() + 60_000)
  await utimes(target, later, later)
  expect((await staleFiles(session)).changed).toEqual([target])
})

test("a file deleted after the agent ran a shell command isn't reported", async () => {
  const session = state()
  const target = path.join(dir, "old.ts")
  await writeFile(target, "x")
  await recordTool(session, { tool: "read", input: { path: "old.ts" }, output: undefined, directory: dir, now: 1 })
  recordShellRun(session, 2, 3)
  await unlink(target)
  expect(await staleFiles(session)).toEqual({ changed: [], deleted: [] })
})
