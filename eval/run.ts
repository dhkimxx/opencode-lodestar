// Runs evaluation scenarios against isolated OpenCode servers. See eval/README.md.
import { appendFile, cp, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { measure, outsideAccess, type Metrics } from "./lib/metrics"
import { exportCredentials, Instance } from "./lib/opencode"
import type { CheckResult, Scenario } from "./lib/scenario"
import { scenarios } from "./scenarios"

const REPO = path.resolve(import.meta.dir, "..")
// The agent sees its project's path. A path that names this repository, or the folder it lives in, led a model to
// go looking for the "real" project and edit these fixtures, so projects live under a name that gives nothing away.
const WORKSPACES = path.join(homedir(), ".cache", "ws")

/** A: OpenCode alone. B: with lodestar. B-Tn: lodestar with one feature switched off. */
const CONFIGS: Record<string, { plugin: boolean; disable?: string }> = {
  A: { plugin: false },
  B: { plugin: true },
  "B-T2": { plugin: true, disable: "T2" },
  "B-T4": { plugin: true, disable: "T4" },
  "B-T6": { plugin: true, disable: "T6" },
}

/** Context windows of the models we evaluate with, from `opencode api model.list`. */
const CONTEXT: Record<string, number> = {
  "opencode-go/beam-free": 1_048_576,
  "opencode-go/longcat-2.5-preview-free": 1_000_000,
  "opencode-go/mimo-v2.5": 1_000_000,
  "opencode-go/mimo-v2.6-flash": 1_048_576,
}

const { values } = parseArgs({
  options: {
    configs: { type: "string", default: "A" },
    scenarios: { type: "string", default: scenarios.map((scenario) => scenario.id).join(",") },
    repeat: { type: "string", default: "1" },
    model: { type: "string", default: "opencode-go/beam-free" },
    context: { type: "string" },
    // Auto compaction starts at this many tokens, so short scenarios still compact mid-task.
    threshold: { type: "string", default: "60000" },
    concurrency: { type: "string", default: "2" },
    "turn-timeout": { type: "string", default: String(15 * 60_000) },
    "bun-dir": { type: "string", default: process.env.BUN_DIR ?? path.dirname(Bun.which("bun") ?? "/usr/bin/bun") },
    out: { type: "string", default: path.join(REPO, "eval/.runs", new Date().toISOString().replace(/[:.]/g, "-")) },
  },
})

const model = values.model
const context = Number(values.context ?? CONTEXT[model] ?? 0)
if (!context) throw new Error(`unknown context window for ${model}; pass --context`)
const threshold = Number(values.threshold)
const turnTimeout = Number(values["turn-timeout"])
const bunDir = path.resolve(values["bun-dir"])
const out = path.resolve(values.out)
process.env.PATH = [bunDir, process.env.PATH].join(":")

const selectedConfigs = values.configs.split(",").map((name) => {
  const config = CONFIGS[name]
  if (!config) throw new Error(`unknown config ${name}`)
  return { name, ...config }
})
const selectedScenarios = values.scenarios.split(",").map((id) => {
  const scenario = scenarios.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`unknown scenario ${id}`)
  return scenario
})

interface StepLog {
  step: number
  kind: string
  ms: number
  detail?: string
}

export interface RunResult {
  model: string
  config: string
  scenario: string
  repeat: number
  ok: boolean
  error?: string
  check?: CheckResult
  metrics?: Metrics
  steps: StepLog[]
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "eval",
      GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "eval",
      GIT_COMMITTER_EMAIL: "eval@example.invalid",
    },
  })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
}

const running = new Set<Instance>()

async function gitOutput(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return text.trim()
}

/** Puts the fixtures back if an agent changed them, and says whether it had to. */
async function restoreFixtures(): Promise<boolean> {
  if (!(await gitOutput(REPO, "status", "--porcelain", "--", "eval/fixtures"))) return false
  await gitOutput(REPO, "checkout", "--", "eval/fixtures")
  await gitOutput(REPO, "clean", "-fdq", "--", "eval/fixtures")
  return true
}

async function runOne(
  config: (typeof selectedConfigs)[number],
  scenario: Scenario,
  repeat: number,
  credentials: Uint8Array,
): Promise<RunResult> {
  const root = path.join(out, `${config.name}-${scenario.id}-${repeat}`)
  const workdir = path.join(WORKSPACES, crypto.randomUUID().slice(0, 8), "project")
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await cp(path.join(REPO, "eval/fixtures", scenario.fixture), workdir, { recursive: true })
  await git(workdir, "init", "-q", "-b", "main")
  await git(workdir, "add", "-A")
  await git(workdir, "commit", "-q", "-m", "fixture")

  const instance = new Instance({
    root,
    workdir,
    pathPrefix: bunDir,
    config: {
      model,
      compaction: { buffer: context - threshold },
      ...(config.plugin ? { plugins: [REPO] } : {}),
    },
    env: config.plugin
      ? { LODESTAR_TRACE: path.join(root, "trace.jsonl"), ...(config.disable ? { LODESTAR_DISABLE: config.disable } : {}) }
      : {},
  })
  running.add(instance)
  const steps: StepLog[] = []
  const result: RunResult = { model, config: config.name, scenario: scenario.id, repeat, ok: false, steps }
  let sessionID: string | undefined
  try {
    await instance.setup(credentials)
    await instance.start()
    for (const [index, step] of scenario.steps.entries()) {
      const started = Date.now()
      if (step.kind === "turn") {
        const turn = await instance.turn({ sessionID, model, message: step.message, timeoutMs: turnTimeout })
        sessionID = turn.sessionID
        await Bun.write(path.join(root, `turn-${index}.jsonl`), turn.stdout)
        if (turn.stderr.trim()) await Bun.write(path.join(root, `turn-${index}.err`), turn.stderr)
        const detail = turn.timedOut ? "timed out" : turn.code === 0 ? undefined : `exit ${turn.code}`
        steps.push({ step: index, kind: "turn", ms: Date.now() - started, detail })
        if (!sessionID) throw new Error(`turn ${index} started no session: ${turn.stderr.trim().slice(-500)}`)
      } else if (step.kind === "compact") {
        if (!sessionID) throw new Error("compaction before the first turn")
        const message = await instance.compact(sessionID, 10 * 60_000)
        steps.push({ step: index, kind: "compact", ms: Date.now() - started, detail: message.status })
      } else {
        await step.apply(workdir)
        steps.push({ step: index, kind: "edit", ms: Date.now() - started, detail: step.note })
      }
    }
    if (!sessionID) throw new Error("no session")
    const data = await instance.export(sessionID)
    await Bun.write(path.join(root, "export.json"), JSON.stringify(data, null, 2))
    // A session opened anywhere else could have read or changed files outside the copy, such as these scripts.
    const directory = (data.info as { location?: { directory?: string } }).location?.directory
    if (directory !== workdir) throw new Error(`session ran in ${directory}, not in the work directory`)
    const outside = outsideAccess(data, workdir, homedir(), [bunDir])
    if (outside.length > 0) throw new Error(`the agent left its project: ${outside.slice(0, 3).join(", ")}`)
    // A turn that ended in a provider error says nothing about the agent, so the run doesn't count.
    const failed = data.messages.find((message) => message.type === "idle" && "outcome" in message && message.outcome === "failed")
    if (failed) {
      const error = (failed as { error?: { message?: string } }).error
      throw new Error(`a turn failed: ${error?.message ?? "unknown error"}`)
    }
    result.metrics = measure(data)
    result.check = await scenario.check({ workdir, data })
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    if (sessionID) {
      const data = await instance.export(sessionID).catch(() => undefined)
      if (data) await Bun.write(path.join(root, "export.json"), JSON.stringify(data, null, 2))
    }
  } finally {
    await instance.stop()
    await instance.cleanup()
    running.delete(instance)
    await cp(workdir, path.join(root, "work"), { recursive: true }).catch(() => {})
    await rm(path.dirname(workdir), { recursive: true, force: true })
  }
  if (await restoreFixtures()) {
    result.ok = false
    result.error = "the agent changed the fixtures in this repository; they were restored"
  }
  await Bun.write(path.join(root, "result.json"), JSON.stringify(result, null, 2))
  return result
}

async function stopAll() {
  await Promise.allSettled(
    [...running].map(async (instance) => {
      // Credentials go first, in case a server is slow to stop.
      await instance.cleanup()
      await Promise.race([instance.stop(), Bun.sleep(5_000)])
      await instance.cleanup()
    }),
  )
  process.exit(130)
}
process.on("SIGINT", stopAll)
process.on("SIGTERM", stopAll)

await mkdir(out, { recursive: true })
if (await gitOutput(REPO, "status", "--porcelain", "--", "eval/fixtures")) throw new Error("eval/fixtures has uncommitted changes")
const credentials = await exportCredentials(model.split("/")[0] ?? "opencode-go")
const jobs = selectedConfigs.flatMap((config) =>
  selectedScenarios.flatMap((scenario) =>
    Array.from({ length: Number(values.repeat) }, (_, index) => ({ config, scenario, repeat: index + 1 })),
  ),
)
console.log(`${jobs.length} runs with ${model}, results in ${out}`)

let next = 0
async function worker() {
  for (;;) {
    const job = jobs[next++]
    if (!job) return
    let result = await runOne(job.config, job.scenario, job.repeat, credentials)
    // Free models are rate limited. A limited run says nothing about the agent, so wait and run it again.
    for (let attempt = 1; attempt <= 3 && /rate limit/i.test(result.error ?? ""); attempt++) {
      console.log(`${job.config.name} ${job.scenario.id} #${job.repeat}: rate limited, retrying in ${attempt} minute(s)`)
      await Bun.sleep(attempt * 60_000)
      result = await runOne(job.config, job.scenario, job.repeat, credentials)
    }
    await appendFile(path.join(out, "results.jsonl"), JSON.stringify(result) + "\n")
    const status = !result.ok ? `error: ${result.error}` : result.check?.success ? "success" : "fail"
    const tokens = result.metrics ? result.metrics.tokens.input + result.metrics.tokens.cacheRead : 0
    console.log(
      `${job.config.name} ${job.scenario.id} #${job.repeat}: ${status}, score ${result.check?.score.toFixed(2) ?? "-"}, prompt tokens ${tokens}, ${result.check?.notes.join("; ") ?? ""}`,
    )
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker))
