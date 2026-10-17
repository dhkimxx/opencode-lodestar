// Docker helpers and grading, shared by run.ts and regrade.ts.
import { readdir } from "node:fs/promises"
import path from "node:path"

export interface Task {
  id: string
  dir: string
  image: string
  instruction: string
}

export async function loadTask(tasksDir: string, id: string): Promise<Task> {
  const dir = path.join(tasksDir, id)
  const toml = await Bun.file(path.join(dir, "task.toml")).text()
  const image = toml.match(/^docker_image\s*=\s*"([^"]+)"/m)?.[1]
  if (!image) throw new Error(`no docker_image in ${id}/task.toml`)
  return { id, dir, image, instruction: await Bun.file(path.join(dir, "instruction.md")).text() }
}

export interface Exec {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function docker(args: string[], options: { stdin?: Uint8Array; timeoutMs?: number } = {}): Promise<Exec> {
  const proc = Bun.spawn(["docker", ...args], { stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        proc.kill("SIGKILL")
      }, options.timeoutMs)
    : undefined
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}

export async function must(args: string[], options?: Parameters<typeof docker>[1]) {
  const result = await docker(args, options)
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim().slice(-500)}`)
  return result
}

/** Containers this process started and hasn't removed yet. Task containers hold a copy of the credentials. */
export const containers = { running: new Set<string>(), stopping: false }

/** Starts a container that is removed on Ctrl-C, and refuses once stopping has begun. */
export async function launch(name: string, args: string[], options?: Parameters<typeof docker>[1]) {
  if (containers.stopping) throw new Error("stopping")
  containers.running.add(name)
  const result = await docker(["run", "--name", name, ...args], options)
  // A container that came up while the others were being removed is removed here instead.
  if (containers.stopping) await docker(["rm", "-f", name])
  return result
}

/** Removes every container still running and exits. A second pass catches one that was still starting. */
export async function stopAll() {
  containers.stopping = true
  for (let pass = 0; pass < 2; pass++) {
    await Promise.allSettled([...containers.running].map((name) => docker(["rm", "-f", name])))
    await Bun.sleep(3_000)
  }
  process.exit(130)
}

/** Applies the agent's diff to a fresh container and runs the task's own verifier, as the benchmark's re-grading does. */
export async function grade(task: Task, patch: string, root: string) {
  const name = `lodestar-grade-${crypto.randomUUID().slice(0, 8)}`
  const script = [
    "cd /app 2>/dev/null || cd /testbed",
    "if [ -s /tmp/model.patch ]; then git apply --verbose /tmp/model.patch || git apply --3way /tmp/model.patch || patch --fuzz=3 -p1 -i /tmp/model.patch; fi",
    "bash /tests/test.sh",
  ].join("; ")
  await Bun.file(path.join(root, "reward.txt"))
    .delete()
    .catch(() => {})
  try {
    const result = await launch(
      name,
      [
        "--memory", "6g", "--cpus", "2",
        // Docker reads a relative source as the name of a volume, so both paths are made absolute.
        "-v", `${path.resolve(task.dir, "tests")}:/tests:ro`, "-v", `${path.resolve(patch)}:/tmp/model.patch:ro`,
        "--entrypoint", "bash", task.image, "-c", script,
      ],
      { timeoutMs: 55 * 60_000 },
    )
    await Bun.write(path.join(root, "verifier.log"), `${result.stdout}\n--- stderr ---\n${result.stderr}`)
    await docker(["cp", `${name}:/logs/verifier/reward.txt`, path.join(root, "reward.txt")])
    const reward = await Bun.file(path.join(root, "reward.txt"))
      .text()
      .catch(() => "")
    // No reward file means the verifier never ran, which is not the same as a failed task.
    if (!reward.trim()) throw new Error(`grading did not run: ${result.stderr.trim().slice(-300)}`)
    return { success: reward.trim() === "1", timedOut: result.timedOut }
  } finally {
    await docker(["rm", "-f", name])
    containers.running.delete(name)
  }
}

/** One line per run directory, from its latest result, so a run done again replaces its earlier attempt. */
export async function writeResults(out: string) {
  const lines: string[] = []
  for (const entry of (await readdir(out, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    const file = Bun.file(path.join(out, entry.name, "result.json"))
    if (await file.exists()) lines.push(JSON.stringify(await file.json()))
  }
  await Bun.write(path.join(out, "results.jsonl"), lines.sort().join("\n") + "\n")
}
