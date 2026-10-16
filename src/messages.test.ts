import { expect, test } from "bun:test"
import type { Message } from "@opencode/ai"
import { touchedFiles } from "./files"
import { checkpointIndex, insertNearEnd, userMessage } from "./messages"

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
