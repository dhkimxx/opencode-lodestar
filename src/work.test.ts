import { expect, test } from "bun:test"
import { addRange, readRange } from "./files"
import type { SessionState } from "./state"
import { describeCall, isTestCommand, recordCall, recordRequest } from "./work"

const state = (): SessionState => ({ directory: "/repo", files: {}, notes: [], skills: {}, toolStreak: 0, recited: false })

test("reads the range from the read tool's output", () => {
  expect(readRange([{ type: "text", text: "Read file src/a.ts, lines 40-120\n40: x" }])).toEqual([40, 120])
  expect(readRange("Read file a, lines 1-2\n1: a")).toEqual([1, 2])
  expect(readRange([{ type: "text", text: "Directory listing" }])).toBeUndefined()
})

test("merges ranges that overlap or touch, and keeps the latest four", () => {
  expect(addRange([[1, 10]], [11, 20])).toEqual([[1, 20]])
  expect(addRange([[1, 10], [50, 60]], [5, 15])).toEqual([[50, 60], [1, 15]])
  expect(addRange([[1, 2], [10, 12], [20, 22], [30, 32]], [40, 42])).toEqual([[10, 12], [20, 22], [30, 32], [40, 42]])
})

test("describes tool calls in one line", () => {
  const read = [{ type: "text", text: "Read file src/a.ts, lines 40-120\n40: x" }]
  expect(describeCall("read", { path: "/repo/src/a.ts" }, undefined, read, "/repo")).toBe("read src/a.ts, lines 40-120")
  expect(describeCall("edit", { path: "src/a.ts", oldString: "a", newString: "b" }, undefined, undefined, "/repo")).toBe("edit src/a.ts")
  expect(describeCall("shell", { command: "cd /repo &&\n  go test ./..." }, undefined, undefined, "/repo")).toBe("shell `cd /repo && go test ./...`")
  expect(describeCall("grep", { pattern: "parseTax", path: "/repo/src" }, undefined, undefined, "/repo")).toBe("grep `parseTax` in src")
  expect(describeCall("patch", { patchText: "*** Begin Patch" }, { applied: [{ target: "a.ts" }, { target: "b.ts" }] }, undefined, "/repo")).toBe(
    "patch a.ts, b.ts",
  )
})

test("keeps the latest five calls with how they ended, and the latest test run", () => {
  const session = state()
  for (let index = 0; index < 6; index++) recordCall(session, { tool: "read", input: { path: `f${index}.ts` }, directory: "/repo" })
  recordCall(session, {
    tool: "shell",
    input: { command: "bun test" },
    output: { exit: 1 },
    content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `out ${index}`).join("\n") }],
    directory: "/repo",
  })
  recordCall(session, { tool: "edit", input: { path: "a.ts" }, error: "Could not find oldString\nin the file", directory: "/repo" })
  expect(session.calls).toEqual([
    { what: "read f3.ts" },
    { what: "read f4.ts" },
    { what: "read f5.ts" },
    { what: "shell `bun test`", outcome: "exit 1" },
    { what: "edit a.ts", outcome: "failed: Could not find oldString in the file" },
  ])
  expect(session.lastTest?.command).toBe("bun test")
  expect(session.lastTest?.exit).toBe(1)
  expect(session.lastTest?.tail.split("\n")).toHaveLength(20)
  expect(session.lastTest?.tail).toEndWith("out 29")
})

test("tells test commands from others", () => {
  for (const command of ["pytest -x tests/", "cd /app && go test ./pkg/...", "npm test", "yarn run test", "npx jest src", "python -m unittest", "make check", "./gradlew test"]) {
    expect(isTestCommand(command)).toBe(true)
  }
  for (const command of ["git status", "ls tests/", "cat test_parser.py", "go build ./...", "grep -rn latest ."]) {
    expect(isTestCommand(command)).toBe(false)
  }
})

test("keeps the first request and the latest three after it", () => {
  const session = state()
  for (const text of ["first", "second", " second ", "third", "fourth", "fifth"]) recordRequest(session, text)
  expect(session.requests).toEqual(["first", "third", "fourth", "fifth"])
})
