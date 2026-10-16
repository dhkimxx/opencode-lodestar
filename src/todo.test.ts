import { expect, test } from "bun:test"
import { parseTodo, todoSummary } from "./todo"

test("accepts a full list and summarizes it", () => {
  const items = parseTodo({
    items: [
      { text: " slugify ", status: "done" },
      { text: "truncate", status: "in_progress" },
      { text: "README", status: "pending" },
    ],
  })
  expect(items[0]).toEqual({ text: "slugify", status: "done" })
  expect(todoSummary(items)).toBe("Todo list saved: 1 done, 1 in progress, 1 pending.")
  expect(todoSummary([])).toBe("Todo list cleared.")
})

test("rejects malformed items", () => {
  expect(() => parseTodo({})).toThrow("items must be an array")
  expect(() => parseTodo({ items: [{ text: "", status: "done" }] })).toThrow("item 1 needs text")
  expect(() => parseTodo({ items: [{ text: "x", status: "finished" }] })).toThrow("unknown status")
})
