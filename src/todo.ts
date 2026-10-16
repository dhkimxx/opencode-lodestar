import type { TodoItem, TodoStatus } from "./state"

export const TODO_TOOL = "todo"

export const TODO_DESCRIPTION = [
  "Keep a todo list for work with several steps, such as a task with three or more parts or a list from the user.",
  "Send the whole list every time, one item per line: `[ ] item` for pending, `[~] item` for in progress, `[x] item` for done.",
  "It replaces the previous list. Mark an item in progress when you start it and done when it is finished.",
  "The list is shown back to you after the conversation is compacted.",
].join(" ")

// One string, not an array of objects. In evaluation, a model that writes tool calls in XML started breaking its
// tool calls once a tool with nested parameters was offered.
export const TODO_INPUT = {
  type: "object",
  properties: {
    list: { type: "string", description: "The whole list, one item per line, each starting with [ ], [~], or [x]." },
  },
  required: ["list"],
  additionalProperties: false,
} as const

const MARKS: Record<string, TodoStatus> = { " ": "pending", "": "pending", "~": "in_progress", ">": "in_progress", x: "done", X: "done" }

export function parseTodo(input: unknown): TodoItem[] {
  const list = (input as { list?: unknown } | undefined)?.list
  if (typeof list !== "string") throw new Error("list must be a string, one item per line")
  return list
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(?:[-*]\s+)?\[([ xX~>]?)\]\s*(.*)$/)
      const text = (match ? (match[2] ?? "") : line.replace(/^[-*]\s+/, "")).trim()
      if (!text) throw new Error(`an item has no text: ${line}`)
      return { text, status: MARKS[match?.[1] ?? " "] ?? "pending" }
    })
}

export function todoSummary(items: readonly TodoItem[]): string {
  if (items.length === 0) return "Todo list cleared."
  const count = (status: TodoStatus) => items.filter((item) => item.status === status).length
  return `Todo list saved: ${count("done")} done, ${count("in_progress")} in progress, ${count("pending")} pending.`
}
