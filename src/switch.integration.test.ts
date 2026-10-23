import { expect, test } from "bun:test"
import plugin from "./index"

type Handler = (event: any) => Promise<void>

/** A stand-in for what OpenCode gives a plugin: it keeps the hooks and the command so the test can call them. */
function host(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, Handler>()
  const store = new Map<string, unknown>()
  const posted: { sessionID: string; text: string; description?: string; resume?: boolean }[] = []
  let command: { execute: (input: unknown) => Promise<void> } | undefined
  const register = (kind: string) => async (name: string, handler: Handler) => {
    hooks.set(`${kind}.${name}`, handler)
    return { dispose: async () => void hooks.delete(`${kind}.${name}`) }
  }
  const ctx = {
    options,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
    },
    tool: { hook: register("tool") },
    session: {
      hook: register("session"),
      get: async () => ({ location: { directory: "/repo" } }),
      synthetic: async (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => void posted.push(input),
    },
    command: {
      transform: async (callback: (editor: { add: (definition: any) => void }) => void) => {
        callback({ add: (definition) => void (command = definition) })
        return { dispose: async () => void (command = undefined) }
      },
    },
    model: { list: async () => [] },
    event: { subscribe: async function* () {} },
  }
  return { ctx, hooks, store, posted, run: (text: string) => command!.execute({ sessionID: "ses_1", prompt: { text }, delivery: "steer" }) }
}

const recorded = (store: Map<string, unknown>) => [...store.keys()].filter((key) => key.startsWith("session/"))
const prompt = (h: ReturnType<typeof host>) => h.hooks.get("session.prompt")!({ sessionID: "ses_1", prompt: { text: "fix the bug" } })
const settle = () => new Promise((resolve) => setTimeout(resolve, 350))

test("records requests while on, and stops after /lodestar off", async () => {
  const h = host()
  await plugin.setup(h.ctx as never)
  await prompt(h)
  await settle()
  expect(recorded(h.store)).toEqual(["session/ses_1"])
  h.store.clear()
  await h.run("off")
  await prompt(h)
  await settle()
  expect(recorded(h.store)).toEqual([])
  expect(h.posted.at(-1)).toMatchObject({ sessionID: "ses_1", resume: false })
  expect(h.posted.at(-1)!.text).toContain("lodestar is off")
  expect(h.posted.at(-1)!.description).toBe(h.posted.at(-1)!.text)
})

test("starts off when the option says so, and /lodestar on turns it on", async () => {
  const h = host({ enabled: false })
  await plugin.setup(h.ctx as never)
  await prompt(h)
  await settle()
  expect(recorded(h.store)).toEqual([])
  await h.run("status")
  expect(h.posted.at(-1)!.text).toContain("`enabled` is false in its options")
  await h.run("on")
  await prompt(h)
  await settle()
  expect(recorded(h.store)).toEqual(["session/ses_1"])
})

test("the choice is kept across a restart", async () => {
  const first = host()
  await plugin.setup(first.ctx as never)
  await first.run("off")
  const second = host()
  second.store.set("enabled", first.store.get("enabled"))
  await plugin.setup(second.ctx as never)
  await prompt(second)
  await settle()
  expect(recorded(second.store)).toEqual([])
})

test("answers an unknown word with the usage, and changes nothing", async () => {
  const h = host()
  await plugin.setup(h.ctx as never)
  await h.run("maybe")
  expect(h.posted.at(-1)!.text).toContain("did not understand")
  await prompt(h)
  await settle()
  expect(recorded(h.store)).toEqual(["session/ses_1"])
})

test("keeps its own notices out of what the model reads, whether on or off", async () => {
  for (const word of ["on", "off"]) {
    const h = host()
    await plugin.setup(h.ctx as never)
    await h.run(word)
    const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
    const messages = [user("fix the bug"), user(h.posted.at(-1)!.text)]
    await h.hooks.get("session.context")!({ sessionID: "ses_1", messages, model: { providerID: "p", id: "m" } })
    expect(messages.map((message) => (message.content[0] as { text: string }).text)).toEqual(["fix the bug"])
  }
})
