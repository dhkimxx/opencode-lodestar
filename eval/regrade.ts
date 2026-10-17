// Grades finished runs again from their saved patches, for example after a fix to grading. The agents don't run again.
// usage: bun eval/regrade.ts <output directory> [--concurrency 3]
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { grade, loadTask, stopAll, writeResults } from "./lib/docker"
import type { RunResult } from "./lib/result"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "tasks-dir": { type: "string", default: path.join(homedir(), ".cache/lodestar-eval/SWE-bench_Pro-os/v2/tasks") },
    concurrency: { type: "string", default: "3" },
  },
})
const out = path.resolve(positionals[0] ?? "")
if (!positionals[0]) throw new Error("usage: bun eval/regrade.ts <output directory>")
process.on("SIGINT", stopAll)
process.on("SIGTERM", stopAll)

// Only runs whose agent finished: a run that failed before its patch was saved has nothing to grade.
const roots: string[] = []
for (const entry of (await readdir(out, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
  const root = path.join(out, entry.name)
  if ((await Bun.file(path.join(root, "model.patch")).exists()) && (await Bun.file(path.join(root, "export.json")).exists())) roots.push(root)
}
console.log(`${roots.length} runs to grade in ${out}`)

let next = 0
async function worker() {
  for (;;) {
    const root = roots[next++]
    if (!root) return
    const file = Bun.file(path.join(root, "result.json"))
    const result = (await file.json()) as RunResult
    try {
      const graded = await grade(await loadTask(values["tasks-dir"], result.task), path.join(root, "model.patch"), root)
      const before = result.check?.success
      result.check = { success: graded.success, notes: result.check?.notes ?? [] }
      // A run set aside only because grading failed counts once it is graded.
      if (!result.ok && result.metrics && /^grading did not run/.test(result.error ?? "")) {
        result.ok = true
        result.error = undefined
      }
      await Bun.write(path.join(root, "result.json"), JSON.stringify(result, null, 2))
      console.log(`${path.basename(root)}: ${before} -> ${graded.success}`)
    } catch (error) {
      console.log(`${path.basename(root)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker))
await writeResults(out)
