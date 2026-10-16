// Re-runs the checks of finished runs, after a check changed. Metrics stay as they were.
// Runs set aside only because the agent seemed to leave its project are looked at again with the allowed paths.
// usage: bun eval/rescore.ts <results.jsonl>...
const allowed = [process.env.BUN_DIR ?? path.join(homedir(), ".cache", "ws", "bin")]
import { copyFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { measure, outsideAccess } from "./lib/metrics"
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
    const setAside = !result.ok && result.error?.startsWith("the agent left its project")
    if ((!result.ok && !setAside) || !scenario) continue
    const root = path.join(path.dirname(file), `${result.config}-${result.scenario}-${result.repeat}`)
    const data = (await Bun.file(path.join(root, "export.json")).json()) as SessionExport
    if (setAside) {
      const directory = (data.info as { location?: { directory?: string } }).location?.directory ?? ""
      if (outsideAccess(data, directory, homedir(), allowed).length > 0) continue
      result.ok = true
      result.error = undefined
      result.metrics = measure(data)
      console.log(`${result.config} ${result.scenario} #${result.repeat}: no longer set aside`)
    }
    const before = result.check?.success
    result.check = await scenario.check({ workdir: path.join(root, "work"), data })
    if (before !== result.check.success) console.log(`${result.config} ${result.scenario} #${result.repeat}: ${before} -> ${result.check.success}`)
  }
  await copyFile(file, `${file}.bak`)
  await Bun.write(file, results.map((result) => JSON.stringify(result)).join("\n") + "\n")
}
