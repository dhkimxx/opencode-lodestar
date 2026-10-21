import { expect, test } from "bun:test"
import { compareVersions, joinCopies } from "./copies"

test("only one copy acts, and the newest version leads", () => {
  const scope = {}
  const pinned = joinCopies(scope, "0.3.0")
  const latest = joinCopies(scope, "0.3.1")
  expect([pinned.leads(), latest.leads()]).toEqual([false, true])
  // An older copy set up later doesn't take over.
  const older = joinCopies(scope, "0.2.0")
  expect([pinned.leads(), latest.leads(), older.leads()]).toEqual([false, true, false])
})

test("between equal versions the copy set up last leads", () => {
  const scope = {}
  const first = joinCopies(scope, "0.3.1")
  const second = joinCopies(scope, "0.3.1")
  expect([first.leads(), second.leads()]).toEqual([false, true])
})

test("the next copy takes over when the leader is unloaded", () => {
  const scope = {}
  const pinned = joinCopies(scope, "0.3.0")
  const latest = joinCopies(scope, "0.3.1")
  latest.leave()
  expect(pinned.leads()).toBe(true)
})

test("a single copy always leads", () => {
  expect(joinCopies({}, "0.3.1").leads()).toBe(true)
})

test("compares versions, pre-releases before their release", () => {
  expect(compareVersions("0.3.1", "0.3.0")).toBe(1)
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1)
  expect(compareVersions("0.3.0", "0.3.0")).toBe(0)
  expect(compareVersions("0.4.0-beta.1", "0.4.0")).toBe(-1)
  expect(compareVersions("0.4.0-beta.10", "0.4.0-beta.2")).toBe(1)
  expect(compareVersions("0.4.0-beta.1", "0.3.9")).toBe(1)
})
