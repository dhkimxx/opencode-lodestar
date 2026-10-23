// Runs SWE-bench Pro tasks through four coding-agent harnesses on the same model, one run at a time, with every request
// metered by one proxy. See eval/bench/README.md.
import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Box, CACHE, ensureProxy, meteredFor } from "./bench/box"
import { codexAgent } from "./bench/codex"
import { summarizeMeter, summarizeTrace, type MeterSummary, type TraceSummary } from "./bench/normalize"
import { openCodeAgent } from "./bench/opencode"
import { ompAgent } from "./bench/omp"
import type { Agent, AgentRun, Context, Login } from "./bench/types"
import { containers, docker, grade, loadTask, stopAll, type Task } from "./lib/docker"
import { exportCredentials, OPENCODE } from "./lib/opencode"

const REPO = path.resolve(import.meta.dir, "..")
const OPENAI_LOGIN = path.join(homedir(), ".local/share/lodestar-eval/openai")

const { values } = parseArgs({
  options: {
    "tasks-dir": { type: "string", default: path.join(CACHE, "SWE-bench_Pro-os/v2/tasks") },
    /** Comma-separated task IDs, or a JSON file with an array of them. */
    tasks: { type: "string" },
    /** A, B, C, D: OpenCode, OpenCode with lodestar, omp, Codex. E: Codex without code mode. F: OpenCode with the guidance prototype. */
    harnesses: { type: "string", default: "A,B,C,D" },
    model: { type: "string", default: "gpt-6-luna" },
    effort: { type: "string", default: "high" },
    /** Tokens at which compaction starts, for every harness, or `A=45000,B=45000,C=60000,D=62000` for each its own. */
    threshold: { type: "string", default: "250000" },
    budget: { type: "string", default: "50" },
    /** A lodestar checkout with a built dist/, for harness B. */
    plugin: { type: "string", default: REPO },
    /** Runs that already counted in this output directory are skipped. */
    out: { type: "string" },
    "prune-images": { type: "boolean", default: false },
    /** Seeds the order the harnesses take within each task. */
    seed: { type: "string", default: "1" },
  },
})
if (!values.out) throw new Error("pass --out, the directory runs are written to")
const out = path.resolve(values.out)

const AGENTS: Record<string, () => Agent> = { A: () => openCodeAgent("A"), B: () => openCodeAgent("B"), C: ompAgent, D: () => codexAgent(), E: () => codexAgent(true), F: () => openCodeAgent("F") }
const harnesses = values.harnesses.split(",")
for (const id of harnesses) if (!AGENTS[id]) throw new Error(`unknown harness ${id}`)

function thresholdFor(id: string) {
  const own = values.threshold.split(",").find((part) => part.startsWith(`${id}=`))
  const value = own ? own.slice(2) : values.threshold.includes("=") ? undefined : values.threshold
  if (!value || !Number.isFinite(Number(value))) throw new Error(`no threshold for ${id}: ${values.threshold}`)
  return Number(value)
}

const pulls = new Map<string, Promise<void>>()
function pull(image: string) {
  let pending = pulls.get(image)
  if (!pending) {
    pending = (async () => {
      if ((await docker(["image", "inspect", image])).code === 0) return
      for (let attempt = 1; ; attempt++) {
        const result = await docker(["pull", "-q", image], { timeoutMs: 60 * 60_000 })
        if (result.code === 0) return
        if (attempt === 3) throw new Error(`docker pull failed: ${result.stderr.trim().slice(-300)}`)
        await Bun.sleep(attempt * 30_000)
      }
    })()
    pending.catch(() => pulls.delete(image))
    pulls.set(image, pending)
  }
  return pending
}

/** OpenCode's musl build at the version the host runs: the one the lodestar evaluation downloads. */
async function opencodeMusl() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_BE_BUN")) as Record<string, string>
  const printed = await new Response(Bun.spawn([OPENCODE, "--version"], { stdout: "pipe", stdin: "ignore", env }).stdout).text()
  const version = printed.match(/\d+\.\d+\.\d+/)?.[0]
  if (!version) throw new Error("could not read the OpenCode version")
  const file = path.join(CACHE, "opencode-musl", version, "opencode")
  if (await Bun.file(file).exists()) return file
  const meta = (await (await fetch(`https://registry.npmjs.org/@opencode%2Fcli-linux-x64-musl/${version}`)).json()) as { dist: { tarball: string; integrity: string } }
  const tarball = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer())
  if (`sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}` !== meta.dist.integrity) throw new Error("OpenCode's musl build does not match its published hash")
  const archive = `${file}.tgz`
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(archive, tarball)
  const extracted = await Bun.spawn(["tar", "xzf", archive, "-C", path.dirname(file), "--strip-components=2", "package/bin/opencode"]).exited
  await rm(archive, { force: true })
  if (extracted !== 0) throw new Error("could not unpack OpenCode's musl build")
  return file
}

let login: Promise<Login> | undefined
/** The evaluation login. Each container holds a copy, and a copy that refreshed the token would invalidate the others. */
function evalLogin() {
  login ??= (async () => {
    const bytes = await exportCredentials("openai", OPENAI_LOGIN)
    const [credential] = JSON.parse(new TextDecoder().decode(bytes)) as { value?: { access?: string; refresh?: string; expires?: number; metadata?: { accountID?: string } } }[]
    const value = credential?.value
    if (!value?.access || !value.refresh || !value.expires || !value.metadata?.accountID) throw new Error("the evaluation OpenAI login has an unexpected shape")
    if (value.expires - Date.now() < 24 * 3_600_000) throw new Error("the evaluation OpenAI login expires within a day; log in again as eval/README.md describes")
    return { access: value.access, refresh: value.refresh, expires: value.expires, accountID: value.metadata.accountID }
  })()
  return login
}

export interface BenchResult {
  harness: string
  label: string
  task: string
  model: string
  effort: string
  threshold: number
  ok: boolean
  error?: string
  resolved?: boolean
  outOfTime?: boolean
  seconds?: number
  patchBytes?: number
  meter?: MeterSummary
  trace?: TraceSummary
  /** Only the first request's prompt and the largest one, to see how close a run came to its threshold. */
}

const runDir = (task: Task, id: string) => path.join(out, `${id}-${task.id.replace(/^instance_/, "").slice(0, 60)}`)

async function runOne(task: Task, id: string): Promise<BenchResult> {
  const agent = AGENTS[id]!()
  const root = runDir(task, id)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const result: BenchResult = { harness: id, label: agent.label, task: task.id, model: values.model, effort: values.effort, threshold: thresholdFor(id), ok: false }
  const box = new Box(task.image, { plugin: id === "B" ? path.resolve(values.plugin) : id === "F" ? path.join(import.meta.dir, "bench/guidance") : undefined, opencodeMusl: await opencodeMusl() })
  try {
    await pull(task.image)
    await box.start()
    const ctx: Context = { box, task, root, login: await evalLogin(), model: values.model, effort: values.effort, budget: Number(values.budget) * 60, threshold: result.threshold }
    await agent.setup(ctx)
    const ran: AgentRun = await agent.run(ctx)
    result.outOfTime = ran.outOfTime
    result.seconds = ran.endedAt - ran.startedAt
    if (ran.failure) throw new Error(ran.failure)
    await agent.collect(ctx)

    // The same capture as the benchmark's own agents: everything the agent changed, new files included.
    await box.exec(["sh", "-c", `git add -A >/dev/null 2>&1; git diff --cached > /tmp/bench/model.patch; git reset -q`])
    const patch = path.join(root, "model.patch")
    await box.copyOut("/tmp/bench/model.patch", patch)
    const lastRequest = Date.now() / 1000
    if (!(await Bun.file(patch).exists())) await Bun.write(patch, "")
    result.patchBytes = Bun.file(patch).size
    await box.remove()

    // The meter's lines for this container while it lived. Addresses are reused, so containers run one at a time.
    const metered = await meteredFor(box.ip, box.startedAt, lastRequest)
    await Bun.write(path.join(root, "meter.jsonl"), metered.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    result.meter = summarizeMeter(metered)
    result.trace = summarizeTrace(await agent.trace(root), box.workdir)
    await Bun.write(path.join(root, "result.json"), JSON.stringify(result, null, 2))

    const graded = await grade(task, patch, root)
    result.resolved = graded.success
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await box.remove()
  }
  await Bun.write(path.join(root, "result.json"), JSON.stringify(result, null, 2))
  return result
}

/** A small seeded shuffle, so the order harnesses take within a task is fixed by the seed and the task. */
function shuffled<T>(items: T[], seed: string) {
  let state = [...seed].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 7)
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap]!, copy[index]!]
  }
  return copy
}

process.on("SIGINT", stopAll)
process.on("SIGTERM", stopAll)

const taskIDs = values.tasks?.endsWith(".json") ? ((await Bun.file(values.tasks).json()) as string[]) : (values.tasks ?? "").split(",").filter(Boolean)
if (taskIDs.length === 0) throw new Error("pass --tasks with task IDs or a JSON file of them")
const tasks = await Promise.all(taskIDs.map((id) => loadTask(values["tasks-dir"], id)))
await mkdir(out, { recursive: true })
await ensureProxy()

const jobs = tasks.flatMap((task) => shuffled(harnesses, `${values.seed}:${task.id}`).map((id) => ({ task, id })))
const todo: typeof jobs = []
for (const job of jobs) {
  const file = Bun.file(path.join(runDir(job.task, job.id), "result.json"))
  if (!((await file.exists()) && ((await file.json()) as BenchResult).ok)) todo.push(job)
}
console.log(`${todo.length} of ${jobs.length} runs to do, in this order, results in ${out}`)
const left = new Map(tasks.map((task) => [task.id, todo.filter((job) => job.task === task).length]))

try {
  for (const [index, job] of todo.entries()) {
    if (containers.stopping) break
    const following = todo.slice(index + 1).find((other) => other.task !== job.task)
    if (following) void pull(following.task.image).catch(() => {})
    let result = await runOne(job.task, job.id)
    // A rate-limited run says nothing about the agent, so wait and run it again. ChatGPT usage limits reset over hours.
    const limited = () => /rate limit|429|usage limit|limit reached/i.test(result.error ?? "")
    for (let attempt = 1; attempt <= 10 && limited(); attempt++) {
      console.log(`${job.id} ${job.task.id}: rate limited, retrying in 30 minutes`)
      await Bun.sleep(30 * 60_000)
      result = await runOne(job.task, job.id)
    }
    const status = !result.ok ? `error: ${result.error}` : result.resolved ? "resolved" : "unresolved"
    const meter = result.meter
    console.log(
      `${job.id} ${job.task.id.slice(0, 60)}: ${status}, ${((result.seconds ?? 0) / 60).toFixed(1)} min, ${meter?.requests ?? "-"} requests, first prompt ${meter?.firstInput ?? "-"}, peak ${meter?.peakInput ?? "-"}, compactions ${result.trace?.compactions ?? "-"}`,
    )
    const remaining = (left.get(job.task.id) ?? 1) - 1
    left.set(job.task.id, remaining)
    if (remaining === 0 && values["prune-images"]) await docker(["rmi", job.task.image])
  }
} finally {
  await Promise.allSettled([...containers.running].map((name) => docker(["rm", "-f", name])))
}
