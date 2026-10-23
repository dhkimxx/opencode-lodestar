import { expect, test } from "bun:test"
import type { Metered } from "./box"
import { filesRead, summarizeMeter, summarizeTrace } from "./normalize"
import type { Trace } from "./types"

const response = (t: number, input: number, cached: number, output: number, extra: Partial<Metered> = {}): Metered => ({
  t, ip: "1", host: "chatgpt.com", kind: "ws", event: "response", model: "gpt-6-luna", effort: "high", usage: { input, cached, output, reasoning: 0 }, ...extra,
})

test("sums the meter's responses, with cached tokens inside the prompt", () => {
  const summary = summarizeMeter([response(1, 1000, 0, 50), response(2, 1100, 900, 20), { ...response(3, 0, 0, 0), event: "denied", host: "auth.openai.com", usage: undefined }])
  expect(summary).toMatchObject({ requests: 2, input: 2100, cached: 900, uncached: 1200, output: 70, firstInput: 1000, peakInput: 1100, models: ["gpt-6-luna"], efforts: ["high"], denied: ["auth.openai.com"] })
  expect(summary.cost).toBeCloseTo((1200 * 0.1 + 900 * 0.01 + 70 * 0.5) / 1e6, 10)
})

test("finds the files a shell command prints", () => {
  expect(filesRead("cat src/a.ts")).toEqual(["src/a.ts"])
  expect(filesRead("sed -n '1,40p' src/a.ts")).toEqual(["src/a.ts"])
  expect(filesRead("cd /app && head -n 20 lib/b.py lib/c.py")).toEqual(["lib/b.py", "lib/c.py"])
  expect(filesRead("grep -rn foo src")).toEqual([])
  expect(filesRead("go test ./...")).toEqual([])
})

test("counts a re-read once per file after a compaction, whether it is a read tool or a shell command", () => {
  const trace: Trace = [
    { type: "tool", name: "read", kind: "read", file: "/app/src/a.ts", ok: true },
    { type: "tool", name: "shell", kind: "shell", command: "cat src/b.ts", ok: true },
    { type: "compaction", method: "summary" },
    { type: "tool", name: "shell", kind: "shell", command: "sed -n '1,9p' src/a.ts", ok: true },
    { type: "tool", name: "read", kind: "read", file: "/app/src/a.ts", ok: true },
    { type: "tool", name: "edit", kind: "edit", file: "/app/src/a.ts", ok: false },
  ]
  expect(summarizeTrace(trace, "/app")).toMatchObject({ toolCalls: 5, failedCalls: 1, reads: 4, rereads: 2, rereadsAfterCompaction: 1, edits: 1, shell: 2, compactions: 1 })
})
