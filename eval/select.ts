// Picks the tasks in tasks.json: long but still solvable ones from every repository. See README.md.
// usage: bun eval/select.ts [SWE-bench_Pro-os/v2] [tasks per repository] > eval/tasks.json
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const root = Bun.argv[2] ?? path.join(homedir(), ".cache/lodestar-eval/SWE-bench_Pro-os/v2")
const perRepo = Number(Bun.argv[3] ?? 3)
// Only four tasks, too few to pick from.
const SKIP = new Set(["tutao/tutanota"])

const hard = new Set((await Bun.file(path.join(root, "hard51_ids.txt")).text()).split(/\s+/).filter(Boolean))
const tasks: { id: string; repo: string; files: number; lines: number }[] = []
for (const id of (await readdir(path.join(root, "tasks"))).sort()) {
  const patch = await Bun.file(path.join(root, "tasks", id, "solution/gold_patch.diff")).text()
  const [owner = "", name = ""] = id.replace(/^instance_/, "").split("__")
  tasks.push({
    id,
    repo: `${owner}/${name.split("-")[0]}`,
    files: patch.match(/^diff --git a\/\S+/gm)?.length ?? 0,
    lines: (patch.match(/^\+(?!\+\+)/gm)?.length ?? 0) + (patch.match(/^-(?!--)/gm)?.length ?? 0),
  })
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const picked: string[] = []
for (const repo of [...new Set(tasks.map((task) => task.repo))].sort()) {
  if (SKIP.has(repo)) continue
  const inRepo = tasks.filter((task) => task.repo === repo)
  const sizes = inRepo.map((task) => task.lines).sort((a, b) => a - b)
  const p80 = sizes[Math.floor(0.8 * (sizes.length - 1))] ?? 0
  // HARD-51 tasks were failed by most model families, so A and B would both fail them.
  const candidates = inRepo
    .filter((task) => !hard.has(task.id) && task.files >= 3)
    .sort((a, b) => Math.abs(a.lines - p80) - Math.abs(b.lines - p80) || byId(a.id, b.id))
  picked.push(...candidates.slice(0, perRepo).map((task) => task.id))
}
console.log(JSON.stringify(picked, null, 1))
