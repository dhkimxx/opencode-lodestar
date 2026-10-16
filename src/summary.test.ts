import { expect, test } from "bun:test"
import type { Message } from "@opencode/ai"
import { looksLikeCheckpoint, summaryPrompt, transcript } from "./summary"

const message = (role: string, content: unknown) => ({ role, content }) as unknown as Message
const toolResult = (name: string, text: string) => message("tool", [{ type: "tool-result", id: name, name, result: { type: "text", value: text } }])

test("turns the conversation into text and keeps the previous checkpoint apart", () => {
  const { previous, text } = transcript(
    [
      message("user", "<conversation-checkpoint>\n<summary>\nold\n</summary>\n</conversation-checkpoint>"),
      message("user", [{ type: "text", text: "Never edit src/legacy/." }]),
      message("assistant", [
        { type: "text", text: "Reading it." },
        { type: "tool-call", id: "1", name: "read", input: { path: "src/a.ts" } },
      ]),
      toolResult("read", "1: export const a = 1"),
    ],
    10_000,
  )
  expect(previous).toContain("<summary>\nold")
  expect(text).toContain("[user]\nNever edit src/legacy/.")
  expect(text).toContain('[tool call: read] {"path":"src/a.ts"}')
  expect(text).toContain("[tool result: read]\n1: export const a = 1")
})

test("shortens old tool output more than recent output", () => {
  const messages = [message("user", [{ type: "text", text: "task" }])]
  for (let index = 0; index < 40; index++) messages.push(toolResult("read", `${index}:${"x".repeat(5_000)}`))
  const { text } = transcript(messages, 1_000_000)
  const lengths = text.split("[tool result: read]\n").slice(1).map((chunk) => chunk.split("\n")[0]?.length ?? 0)
  expect(lengths[0]).toBeLessThan(700)
  expect(lengths.at(-1)).toBeGreaterThan(3_000)
})

test("drops the oldest entries but keeps the first user message when it must", () => {
  const messages = [message("user", [{ type: "text", text: "THE TASK" }])]
  for (let index = 0; index < 50; index++) messages.push(message("assistant", [{ type: "text", text: `step ${index} ${"y".repeat(400)}` }]))
  const { text } = transcript(messages, 1_000)
  expect(text.startsWith("[user]\nTHE TASK")).toBe(true)
  expect(text).toContain("step 49")
  expect(text).not.toContain("step 0 ")
  expect(text.length).toBeLessThanOrEqual(4_000 + 500)
})

test("the prompt asks for every section and carries the previous checkpoint", () => {
  const prompt = summaryPrompt({ previous: "old checkpoint", conversation: "talk" })
  expect(prompt).toContain("## Rules from the user")
  expect(prompt).toContain("<previous-checkpoint>\nold checkpoint")
  expect(looksLikeCheckpoint("## User requests\n## Rules from the user\n## Key facts\n## Files\n## Next step")).toBe(true)
  expect(looksLikeCheckpoint("Sure, here is a summary.")).toBe(false)
})
