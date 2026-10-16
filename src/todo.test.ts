import { expect, test } from "bun:test"
import { parseTodo, todoSummary } from "./todo"

test("reads a checklist, one item per line", () => {
  const items = parseTodo({ list: "[x] slugify\n[~] truncate\n[ ] README\n\n- [X] tests\n* plain item" })
  expect(items).toEqual([
    { text: "slugify", status: "done" },
    { text: "truncate", status: "in_progress" },
    { text: "README", status: "pending" },
    { text: "tests", status: "done" },
    { text: "plain item", status: "pending" },
  ])
  expect(todoSummary(items)).toBe("Todo list saved: 2 done, 1 in progress, 2 pending.")
})

test("an empty list clears it, and bad input is rejected", () => {
  expect(parseTodo({ list: "" })).toEqual([])
  expect(todoSummary([])).toBe("Todo list cleared.")
  expect(() => parseTodo({ items: [] })).toThrow("list must be a string")
  expect(() => parseTodo({ list: "[x] " })).toThrow("an item has no text")
})
