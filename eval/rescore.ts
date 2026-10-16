// Re-runs the checks of finished runs, after a check changed. Metrics stay as they were.
// usage: bun eval/rescore.ts <results.jsonl>...
import { copyFile } from "node:fs/promises"
import path from "node:path"
import type { SessionExport } from "./lib/session"
import type { RunResult } from "./run"
import { scenarios } from "./scenarios"

for (const file of Bun.argv.slice(2)) {
  const results = (await Bun.file(file).text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunResult)
  for (const result of results) {
    const scenario = scenarios.find((candidate) => candidate.id === result.scenario)
    if (!result.ok || !scenario) continue
    const root = path.join(path.dirname(file), `${result.config}-${result.scenario}-${result.repeat}`)
    const data = (await Bun.file(path.join(root, "export.json")).json()) as SessionExport
    const before = result.check?.success
    result.check = await scenario.check({ workdir: path.join(root, "work"), data })
    if (before !== result.check.success) console.log(`${result.config} ${result.scenario} #${result.repeat}: ${before} -> ${result.check.success}`)
  }
  await copyFile(file, `${file}.bak`)
  await Bun.write(file, results.map((result) => JSON.stringify(result)).join("\n") + "\n")
}
