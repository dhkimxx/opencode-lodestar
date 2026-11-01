import { expect, test } from "bun:test"
import type { Message } from "@opencode/ai/effect"
import { touchedFiles } from "./files"
import { checkpointIndex, contentTokens, insertNearEnd, promptSize, removeNotices, requestTokens, textOf, userMessage } from "./messages"

class FakeMessage {
  constructor(
    readonly role: string,
    readonly content: unknown,
  ) {}
  static user(content: string) {
    return new FakeMessage("user", content)
  }
}
const fake = (role: string, text: string) => new FakeMessage(role, [{ type: "text", text }]) as unknown as Message

test("sizes a request the way OpenCode decides to compact", () => {
  const system = [{ type: "text", text: "s".repeat(4_000) }]
  const tools = { read: { description: "d".repeat(2_000), input: {} } }
  const messages = [fake("user", "u".repeat(8_000)), fake("assistant", "a".repeat(400)), fake("tool", "t".repeat(4_000))]
  const request = { system, tools, messages }
  // Without a count, everything is estimated, the system prompt and the tools included.
  expect(requestTokens(request)).toBeGreaterThan(contentTokens(messages) + 1_400)
  expect(promptSize(request, undefined)).toBe(requestTokens(request))
  // With one, only the latest response and what came after it are estimated on top.
  expect(promptSize(request, 30_000)).toBe(30_000 + contentTokens(messages.slice(1)))
  expect(promptSize({ messages: [fake("user", "hi")] }, 30_000)).toBe(30_000)
})

test("counts the instructions once, not again from their metadata", () => {
  const text = "i".repeat(8_000)
  const plain = requestTokens({ system: [{ type: "text", text }], messages: [] })
  const tagged = requestTokens({
    system: [{ type: "text", text, metadata: { experimental: { instructions: [{ key: "AGENTS.md", text }] } } }],
    messages: [],
  })
  expect(tagged).toBe(plain)
})

test("adds to a late count from the response it came with", () => {
  const withID = (id: string, role: string, text: string) => Object.assign(fake(role, text), { id })
  const messages = [
    withID("u1", "user", "u".repeat(800)),
    withID("a1", "assistant", "a".repeat(400)),
    withID("a1", "tool", "t".repeat(4_000)),
    withID("a2", "assistant", "b".repeat(400)),
    withID("a2", "tool", "r".repeat(40_000)),
  ]
  // The count for a2 hasn't arrived yet: what came after a1 is estimated, a2's large result included.
  expect(promptSize({ messages }, 20_000, "a1")).toBe(20_000 + contentTokens(messages.slice(1)))
  expect(promptSize({ messages }, 30_000, "a2")).toBe(30_000 + contentTokens(messages.slice(3)))
  // A response no longer in the request falls back to the latest one.
  expect(promptSize({ messages }, 30_000, "gone")).toBe(30_000 + contentTokens(messages.slice(3)))
})

test("finds the latest checkpoint", () => {
  const messages = [fake("user", "<conversation-checkpoint>\nold"), fake("assistant", "hi"), fake("user", "<conversation-checkpoint>\nnew")]
  expect(checkpointIndex(messages)).toBe(2)
  expect(checkpointIndex([fake("user", "plain")])).toBe(-1)
})

test("builds messages with the host's class and inserts reminders before the newest user message", () => {
  const messages = [fake("assistant", "done"), fake("user", "next request")]
  const reminder = userMessage(messages, "reminder")
  expect(reminder).toBeInstanceOf(FakeMessage)
  if (reminder) insertNearEnd(messages, reminder)
  expect(messages.map((message) => (message as unknown as FakeMessage).content)).toEqual([
    [{ type: "text", text: "done" }],
    "reminder",
    [{ type: "text", text: "next request" }],
  ])
  expect(userMessage([{ role: "user", content: "x" } as unknown as Message], "y")).toBeUndefined()
})

test("knows which files read, edit, write, and patch touch", () => {
  expect(touchedFiles("read", { path: "src/a.ts" }, undefined, "/repo")).toEqual({ read: ["/repo/src/a.ts"], edited: [] })
  expect(touchedFiles("write", { path: "/abs/b.ts" }, undefined, "/repo")).toEqual({ read: [], edited: ["/abs/b.ts"] })
  expect(
    touchedFiles("patch", { patchText: "" }, { applied: [{ type: "update", target: "c.ts" }, { type: "delete", target: "d.ts" }] }, "/repo"),
  ).toEqual({ read: [], edited: ["/repo/c.ts"] })
  expect(touchedFiles("shell", { command: "ls" }, undefined, "/repo")).toEqual({ read: [], edited: [] })
})

test("removes the lines /lodestar posts, and only those", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as unknown as Message
  const messages = [user("fix the bug"), user("lodestar is off. It records and restores nothing."), user("lodestar is on. It restores what you were working on."), user("lodestar did not understand that."), user("lodestar is great, can you check it?")]
  removeNotices(messages)
  expect(messages.map(textOf)).toEqual(["fix the bug", "lodestar is great, can you check it?"])
})
