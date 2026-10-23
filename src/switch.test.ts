import { expect, test } from "bun:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { configured, describe, parseAction, Switch } from "./switch"

function storage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  const api = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => void data.set(key, value),
    remove: async (key: string) => void data.delete(key),
    scan: async () => ({}),
  }
  return { api: api as unknown as StorageDomain, data }
}

test("is on by default", async () => {
  const state = new Switch(storage().api, undefined)
  await state.load()
  expect([state.on, state.source]).toEqual([true, "default"])
})

test("follows the option when nothing was saved", async () => {
  const state = new Switch(storage().api, false)
  await state.load()
  expect([state.on, state.source]).toEqual([false, "config"])
})

test("a saved choice wins over the option, and survives a restart", async () => {
  const store = storage()
  const first = new Switch(store.api, false)
  await first.load()
  await first.set(true)
  expect([first.on, first.source]).toEqual([true, "command"])
  const restarted = new Switch(store.api, false)
  await restarted.load()
  expect([restarted.on, restarted.source]).toEqual([true, "command"])
})

test("a storage that fails leaves the default", async () => {
  const broken = { get: async () => Promise.reject(new Error("no")), set: async () => Promise.reject(new Error("no")) } as unknown as StorageDomain
  const state = new Switch(broken, undefined)
  await state.load()
  await state.set(false)
  expect(state.on).toBe(false)
})

test("reads only a boolean from the options", () => {
  expect(configured({ enabled: false })).toBe(false)
  expect(configured({ enabled: true })).toBe(true)
  expect(configured({ enabled: "no" })).toBeUndefined()
  expect(configured(undefined)).toBeUndefined()
})

test("understands the words after /lodestar", () => {
  expect(parseAction("")).toBe("status")
  expect(parseAction("  Status ")).toBe("status")
  expect(parseAction("OFF")).toBe("off")
  expect(parseAction("on please")).toBe("on")
  expect(parseAction("maybe")).toBeUndefined()
})

test("says which way it is and how to change it", async () => {
  const on = new Switch(storage().api, undefined)
  expect(describe(on)).toContain("lodestar is on")
  const off = new Switch(storage().api, false)
  expect(describe(off)).toContain("`enabled` is false in its options")
  await off.set(false)
  expect(describe(off)).toContain("Run /lodestar on to turn it on again")
})
