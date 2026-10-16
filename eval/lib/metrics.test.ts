import { expect, test } from "bun:test"
import { measure, outsideAccess } from "./metrics"
import type { Message, SessionExport } from "./session"

const tokens = (input: number, cacheRead: number) => ({ input, output: 10, reasoning: 0, cache: { read: cacheRead, write: 0 } })

function tool(name: string, input: Record<string, unknown>, status = "completed") {
  return { type: "tool", id: crypto.randomUUID(), name, state: { status, input } }
}

function assistant(created: number, ...content: ReturnType<typeof tool>[]): Message {
  return { type: "assistant", id: `a${created}`, time: { created, completed: created + 1 }, content, tokens: tokens(100, 0) }
}

const session: SessionExport = {
  info: { id: "ses_test", cost: 0.5, tokens: tokens(300, 900), time: { created: 1000, idle: 9000 } },
  messages: [
    { type: "user", id: "u1", time: { created: 1001 }, text: "first" },
    assistant(1002, tool("read", { path: "/repo/a.ts" }), tool("read", { path: "/repo/b.ts" })),
    assistant(1003, tool("edit", { path: "/repo/a.ts", oldString: "x", newString: "y" })),
    { type: "compaction", id: "c1", time: { created: 2000 }, status: "completed", reason: "manual" },
    { type: "user", id: "u2", time: { created: 2001 }, text: "second" },
    assistant(
      2002,
      tool("read", { path: "/repo/a.ts" }),
      tool("read", { path: "/repo/a.ts" }),
      tool("read", { path: "/repo/c.ts" }),
    ),
    assistant(2003, tool("edit", { path: "/repo/a.ts", oldString: "x", newString: "y" }, "error")),
    assistant(2004, tool("shell", { command: "bun test" })),
    { type: "compaction", id: "c2", time: { created: 3000 }, status: "failed", reason: "auto" },
  ],
}

test("counts reads, rereads, and rereads after a compaction", () => {
  const metrics = measure(session)
  expect(metrics.reads).toBe(5)
  expect(metrics.rereads).toBe(2)
  expect(metrics.rereadsAfterCompaction).toBe(1)
})

test("counts edits, failed edits, and repeated edits", () => {
  const metrics = measure(session)
  expect(metrics.edits).toBe(2)
  expect(metrics.failedEdits).toBe(1)
  expect(metrics.repeatedEdits).toBe(1)
  expect(metrics.toolErrors).toBe(1)
  expect(metrics.shellCommands).toBe(1)
})

test("counts turns, steps, and compactions", () => {
  const metrics = measure(session)
  expect(metrics.turns).toBe(2)
  expect(metrics.steps).toBe(5)
  expect(metrics.compactions).toBe(2)
  expect(metrics.autoCompactions).toBe(1)
  expect(metrics.failedCompactions).toBe(1)
})

test("uses session totals for tokens and cost", () => {
  const metrics = measure(session)
  expect(metrics.tokens.input).toBe(300)
  expect(metrics.tokens.cacheRead).toBe(900)
  expect(metrics.cacheHitRate).toBe(0.75)
  expect(metrics.cost).toBe(0.5)
  expect(metrics.durationMs).toBe(8000)
})

test("finds tool calls that reach outside the project into the user's home", () => {
  const data: SessionExport = {
    info: { id: "s", time: { created: 0 } },
    messages: [
      assistant(
        1,
        tool("read", { path: "/home/me/.cache/ws/ab12/project/src/a.ts" }),
        tool("read", { path: "/home/me/workspace/other-repo/README.md" }),
        tool("shell", { command: "cd /home/me/workspace && ls", workdir: "/home/me/.cache/ws/ab12/project" }),
        tool("shell", { command: "ls /tmp && cat /usr/include/stdio.h" }),
      ),
    ],
  }
  expect(outsideAccess(data, "/home/me/.cache/ws/ab12/project", "/home/me").sort()).toEqual([
    "/home/me/workspace",
    "/home/me/workspace/other-repo/README.md",
  ])
})
