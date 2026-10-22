// Tables from a bench.ts output directory: one row per harness, and the same for the tasks every harness finished.
// Usage: bun eval/bench-report.ts <out dir> [--tasks]
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { BenchResult } from "./bench"

const dir = process.argv[2]
if (!dir) throw new Error("usage: bench-report.ts <out dir> [--tasks]")
const results: BenchResult[] = []
for (const entry of await readdir(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const file = Bun.file(path.join(dir, entry.name, "result.json"))
  if (await file.exists()) results.push((await file.json()) as BenchResult)
}
const counted = results.filter((result) => result.ok && result.meter && result.trace)
const harnesses = [...new Set(counted.map((result) => result.harness))].sort()
const tasks = [...new Set(counted.map((result) => result.task))]
// Only tasks every harness finished, so the rows compare the same work.
const complete = tasks.filter((task) => harnesses.every((id) => counted.some((result) => result.task === task && result.harness === id)))
const rows = (set: string[]) => harnesses.map((id) => counted.filter((result) => result.harness === id && set.includes(result.task)))

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0
}
const k = (value: number) => `${(value / 1000).toFixed(1)}k`

function table(set: string[]) {
  const header = ["harness", "n", "resolved", "cost $", "uncached in", "cached in", "output", "requests", "tool calls", "re-reads", "re-reads after compaction", "compactions", "minutes", "first prompt", "peak prompt"]
  const body = harnesses.map((id, index) => {
    const group = rows(set)[index]!
    const label = group[0]?.label ?? id
    return [
      `${id} ${label}`,
      String(group.length),
      `${group.filter((result) => result.resolved).length}`,
      mean(group.map((result) => result.meter!.cost)).toFixed(4),
      k(mean(group.map((result) => result.meter!.uncached))),
      k(mean(group.map((result) => result.meter!.cached))),
      k(mean(group.map((result) => result.meter!.output))),
      mean(group.map((result) => result.meter!.requests)).toFixed(1),
      mean(group.map((result) => result.trace!.toolCalls)).toFixed(1),
      mean(group.map((result) => result.trace!.rereads)).toFixed(1),
      mean(group.map((result) => result.trace!.rereadsAfterCompaction)).toFixed(1),
      mean(group.map((result) => result.trace!.compactions)).toFixed(1),
      (mean(group.map((result) => result.seconds ?? 0)) / 60).toFixed(1),
      k(median(group.map((result) => result.meter!.firstInput))),
      k(median(group.map((result) => result.meter!.peakInput))),
    ]
  })
  const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((row) => row[column]!.length)))
  const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ")
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n")
}

console.log(`${results.length} runs, ${counted.length} counted, ${results.length - counted.length} not (errors), ${complete.length} tasks finished by every harness (${harnesses.join(", ")})\n`)
console.log("Tasks every harness finished (means per run; first and peak prompt are medians):")
console.log(table(complete))
const problems = counted.filter((result) => result.meter!.models.length > 1 || result.meter!.efforts.filter((effort) => effort !== "none").length > 1 || result.meter!.denied.length > 0)
for (const result of problems) console.log(`check ${result.harness} ${result.task}: models ${result.meter!.models}, efforts ${result.meter!.efforts}, denied ${result.meter!.denied}`)
if (process.argv.includes("--tasks")) {
  console.log("\nPer task (resolved, cost $, compactions):")
  for (const task of complete) {
    const cells = harnesses.map((id) => {
      const result = counted.find((r) => r.task === task && r.harness === id)!
      return `${id}:${result.resolved ? "yes" : "no"} $${result.meter!.cost.toFixed(4)} c${result.trace!.compactions}`
    })
    console.log(`${task.replace("instance_", "").slice(0, 44).padEnd(44)} ${cells.join("   ")}`)
  }
}
