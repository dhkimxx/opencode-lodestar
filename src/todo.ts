import type { TodoItem, TodoStatus } from "./state"

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"]

export const TODO_TOOL = "todo"

export const TODO_DESCRIPTION = [
  "Keep a todo list for work with several steps, such as a task with three or more parts or a list from the user.",
  "Send the whole list every time. It replaces the previous one.",
  "Mark an item in_progress when you start it and done when it is finished.",
  "The list is shown back to you after the conversation is compacted.",
].join(" ")

export const TODO_INPUT = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "The full list, in order.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "What the item is, in a few words." },
          status: { type: "string", enum: STATUSES },
        },
        required: ["text", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const

export function parseTodo(input: unknown): TodoItem[] {
  const items = (input as { items?: unknown } | undefined)?.items
  if (!Array.isArray(items)) throw new Error("items must be an array")
  return items.map((item, index) => {
    const { text, status } = (item ?? {}) as { text?: unknown; status?: unknown }
    if (typeof text !== "string" || !text.trim()) throw new Error(`item ${index + 1} needs text`)
    if (!STATUSES.includes(status as TodoStatus)) throw new Error(`item ${index + 1} has an unknown status: ${String(status)}`)
    return { text: text.trim(), status: status as TodoStatus }
  })
}

export function todoSummary(items: readonly TodoItem[]): string {
  if (items.length === 0) return "Todo list cleared."
  const count = (status: TodoStatus) => items.filter((item) => item.status === status).length
  return `Todo list saved: ${count("done")} done, ${count("in_progress")} in progress, ${count("pending")} pending.`
}
