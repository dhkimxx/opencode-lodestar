// Picks the tasks in tasks.json and tasks-hard.json from every repository. See README.md.
// usage: bun eval/select.ts [--hard] [SWE-bench_Pro-os/v2] > eval/tasks.json (or eval/tasks-hard.json)
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const args = Bun.argv.slice(2)
const hardMode = args.includes("--hard")
const root = args.find((arg) => arg !== "--hard") ?? path.join(homedir(), ".cache/lodestar-eval/SWE-bench_Pro-os/v2")
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

// tasks-hard.json leaves out what tasks.json already has.
const taken = hardMode ? new Set((await Bun.file(path.join(import.meta.dir, "tasks.json")).json()) as string[]) : new Set<string>()
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const picked: string[] = []
for (const repo of [...new Set(tasks.map((task) => task.repo))].sort()) {
  if (SKIP.has(repo)) continue
  const inRepo = tasks.filter((task) => task.repo === repo)
  const sizes = inRepo.map((task) => task.lines).sort((a, b) => a - b)
  const target = sizes[Math.floor((hardMode ? 0.95 : 0.8) * (sizes.length - 1))] ?? 0
  // HARD-51 tasks were failed by most model families, so A and B would both fail most of them.
  const candidates = inRepo
    .filter((task) => !hard.has(task.id) && !taken.has(task.id) && task.files >= (hardMode ? 4 : 3))
    .sort((a, b) => Math.abs(a.lines - target) - Math.abs(b.lines - target) || byId(a.id, b.id))
  picked.push(...candidates.slice(0, 3).map((task) => task.id))
  // The hard set adds the HARD-51 task with the most work in each repository.
  if (hardMode) {
    const hardest = inRepo.filter((task) => hard.has(task.id)).sort((a, b) => b.lines - a.lines || byId(a.id, b.id))[0]
    if (hardest) picked.push(hardest.id)
  }
}
console.log(JSON.stringify(picked, null, 1))
