// Runs SWE-bench Pro tasks through OpenCode inside each task's own container, with and without lodestar.
// See eval/README.md.
import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { measure } from "./lib/metrics"
import { exportCredentials, OPENCODE } from "./lib/opencode"
import type { SessionExport } from "./lib/session"
import { containers, docker, grade, launch, loadTask, must, stopAll, writeResults, type Exec, type Task } from "./lib/docker"
import type { RunResult } from "./lib/result"

const REPO = path.resolve(import.meta.dir, "..")
const NETWORK = "lodestar-eval"
const PROXY = "lodestar-eval-proxy"
const PROXY_URL = `http://${PROXY}:3128`
/** OpenCode builds and ripgrep, mounted read-only into every task container, and the PATH entry that picks a build. */
const MOUNTS = "/opt/lodestar-eval"
const TOOLS = `${MOUNTS}/bin`
const PLUGIN = "/opt/lodestar"
const STATE = "/tmp/lodestar-eval"
const SERVER = "http://127.0.0.1:4096"
const RIPGREP = path.join(homedir(), ".cache/opencode/bin/rg")
/** The OpenAI login made only for evaluation. Never copy the user's own: ChatGPT refresh tokens are single-use. */
const OPENAI_LOGIN = path.join(homedir(), ".local/share/lodestar-eval/openai")

const { values } = parseArgs({
  options: {
    "tasks-dir": { type: "string", default: path.join(homedir(), ".cache/lodestar-eval/SWE-bench_Pro-os/v2/tasks") },
    /** Comma-separated task IDs, or a JSON file with an array of them. */
    tasks: { type: "string" },
    models: { type: "string", default: "opencode-go/glm-5.3-flash#high" },
    configs: { type: "string", default: "A,B" },
    repeat: { type: "string", default: "1" },
    // Auto compaction starts at this many tokens. The models' windows are far larger, and most sessions never get
    // near them, so the threshold sits low enough that the longer sessions compact.
    threshold: { type: "string", default: "50000" },
    // Minutes the agent gets, as in the benchmark's protocol. The partial work is graded when time runs out.
    budget: { type: "string", default: "50" },
    concurrency: { type: "string", default: "3" },
    // Removes each task's image once all of its runs are done.
    "prune-images": { type: "boolean", default: false },
    out: { type: "string", default: path.join(REPO, "eval/.runs", new Date().toISOString().replace(/[:.]/g, "-")) },
  },
})
const out = path.resolve(values.out)

/** Task containers sit on an internal network. The proxy is their only way out, and it allows only the model APIs. */
async function ensureProxy() {
  if ((await docker(["network", "inspect", NETWORK])).code !== 0) await must(["network", "create", "--internal", NETWORK])
  if ((await docker(["inspect", "-f", "{{.State.Running}}", PROXY])).stdout.trim() === "true") return
  await docker(["rm", "-f", PROXY])
  const config = path.join(import.meta.dir, "squid.conf")
  await must(["run", "-d", "--name", PROXY, "-v", `${config}:/etc/squid/squid.conf:ro`, "ubuntu/squid:latest"])
  await must(["network", "connect", NETWORK, PROXY])
}

const pulls = new Map<string, Promise<void>>()
/** Downloads an image once. A dropped connection gets two more tries, and a pull that still fails can be tried again later. */
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

let musl: Promise<string> | undefined
/** OpenCode's musl build, at the version the host runs, downloaded once from npm and checked against its published hash. */
function muslBuild() {
  musl ??= (async () => {
    // Without BUN_BE_BUN, which the bun wrapper sets and which would make the OpenCode binary act as bun.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_BE_BUN")) as Record<string, string>
    const printed = await new Response(Bun.spawn([OPENCODE, "--version"], { stdout: "pipe", stdin: "ignore", env }).stdout).text()
    const version = printed.match(/\d+\.\d+\.\d+/)?.[0]
    if (!version) throw new Error("could not read the OpenCode version")
    const file = path.join(homedir(), ".cache/lodestar-eval/opencode-musl", version, "opencode")
    if (await Bun.file(file).exists()) return file
    const meta = (await (await fetch(`https://registry.npmjs.org/@opencode%2Fcli-linux-x64-musl/${version}`)).json()) as {
      dist: { tarball: string; integrity: string }
    }
    const tarball = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer())
    if (`sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}` !== meta.dist.integrity)
      throw new Error("OpenCode's musl build does not match its published hash")
    const archive = `${file}.tgz`
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(archive, tarball)
    const extracted = await Bun.spawn(["tar", "xzf", archive, "-C", path.dirname(file), "--strip-components=2", "package/bin/opencode"]).exited
    await rm(archive, { force: true })
    if (extracted !== 0) throw new Error("could not unpack OpenCode's musl build")
    return file
  })()
  return musl
}

const credentials = new Map<string, Promise<Uint8Array>>()
function credentialsFor(provider: string) {
  let pending = credentials.get(provider)
  if (!pending) {
    pending = (async () => {
      if (provider !== "openai") return exportCredentials(provider)
      const bytes = await exportCredentials("openai", OPENAI_LOGIN)
      const [credential] = JSON.parse(new TextDecoder().decode(bytes)) as { value?: { expires?: number } }[]
      // Each container holds a copy. A copy that had to refresh the token would invalidate all the others.
      if ((credential?.value?.expires ?? 0) - Date.now() < 24 * 3_600_000)
        throw new Error("the evaluation OpenAI login expires within a day; log in again as eval/README.md describes")
      return bytes
    })()
    credentials.set(provider, pending)
  }
  return pending
}

/** One task container with OpenCode serving inside it, so the agent's commands run in the task's environment. */
class Sandbox {
  readonly name = `lodestar-eval-${crypto.randomUUID().slice(0, 8)}`
  private readonly password = crypto.randomUUID()
  private env: string[] = []
  workdir = "/app"

  constructor(private readonly image: string) {}

  async start() {
    const imageEnv = JSON.parse((await must(["image", "inspect", "-f", "{{json .Config.Env}}", this.image])).stdout) as string[]
    const imagePath = imageEnv.find((entry) => entry.startsWith("PATH="))?.slice(5) ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    const started = await launch(this.name, [
      "-d", "--network", NETWORK, "--memory", "6g", "--cpus", "2",
      "-v", `${OPENCODE}:${MOUNTS}/opencode-glibc:ro`, "-v", `${await muslBuild()}:${MOUNTS}/opencode-musl:ro`,
      "-v", `${RIPGREP}:${MOUNTS}/rg:ro`, "-v", `${REPO}:${PLUGIN}:ro`,
      "--entrypoint", "tail", this.image, "-f", "/dev/null",
    ])
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr.trim().slice(-500)}`)
    // Some task images are Alpine, where only OpenCode's musl build runs.
    const linked = await this.exec(
      [
        "sh", "-c",
        `libc=glibc; [ -e /lib/ld-musl-x86_64.so.1 ] && libc=musl; mkdir -p ${TOOLS} && ln -sf ${MOUNTS}/opencode-$libc ${TOOLS}/opencode && ln -sf ${MOUNTS}/rg ${TOOLS}/rg`,
      ],
      { workdir: "/" },
    )
    if (linked.code !== 0) throw new Error(`could not link OpenCode: ${linked.stderr.trim().slice(-300)}`)
    this.workdir = (await this.exec(["sh", "-c", "test -d /app/.git && echo /app || echo /testbed"], { workdir: "/" })).stdout.trim()
    this.env = [
      `PATH=${TOOLS}:${imagePath}`,
      `PWD=${this.workdir}`,
      `XDG_DATA_HOME=${STATE}/xdg/data`,
      `XDG_CONFIG_HOME=${STATE}/xdg/config`,
      `XDG_STATE_HOME=${STATE}/xdg/state`,
      `XDG_CACHE_HOME=${STATE}/xdg/cache`,
      ...["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map((key) => `${key}=${PROXY_URL}`),
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
      "OPENCODE_DISABLE_AUTOUPDATE=1",
      `OPENCODE_PASSWORD=${this.password}`,
    ]
    await this.exec(["mkdir", "-p", ...["data", "config", "state", "cache"].map((dir) => `${STATE}/xdg/${dir}`)])
  }

  exec(command: string[], options: { stdin?: Uint8Array; timeoutMs?: number; workdir?: string } = {}) {
    const env = this.env.flatMap((entry) => ["-e", entry])
    const workdir = options.workdir ?? this.workdir
    return docker(["exec", ...(options.stdin ? ["-i"] : []), "-w", workdir, ...env, this.name, ...command], options)
  }

  async login(credentials: Uint8Array) {
    const imported = await this.exec([`${TOOLS}/opencode`, "auth", "import", "--standalone"], { stdin: credentials, timeoutMs: 120_000 })
    if (imported.code !== 0) throw new Error(`auth import failed: ${imported.stderr.trim().slice(-300)}`)
  }

  /**
   * The size OpenCode compacts against: the model's input limit, or its window when it has none. Read here, with the
   * run's own login, because limits depend on it: through a ChatGPT login, OpenAI models take less than through the API.
   */
  async window(model: string, root: string) {
    const listed = await this.exec(["sh", "-c", `${TOOLS}/opencode api model.list --standalone > ${STATE}/models.json`], { timeoutMs: 120_000 })
    if (listed.code !== 0) throw new Error(`model list failed: ${listed.stderr.trim().slice(-300)}`)
    await this.copyOut(`${STATE}/models.json`, path.join(root, "models.json"))
    const data = (await Bun.file(path.join(root, "models.json")).json()) as unknown
    type Listed = { providerID?: string; id?: string; limit?: { context?: number; input?: number } }
    const list = (Array.isArray(data) ? data : (data as { data?: unknown }).data) as Listed[] | undefined
    const [providerID, rest = ""] = model.split("/")
    const found = list?.find((entry) => entry.providerID === providerID && entry.id === rest.split("#")[0])
    const window = found?.limit?.input || found?.limit?.context
    if (!window) throw new Error(`no limits listed for ${model}`)
    return window
  }

  async serve(serverEnv: string[]) {
    const env = [...this.env, ...serverEnv].flatMap((entry) => ["-e", entry])
    await must([
      "exec", "-d", "-w", this.workdir, ...env, this.name, "sh", "-c",
      `exec ${TOOLS}/opencode serve --hostname 127.0.0.1 --port 4096 > ${STATE}/server.out 2> ${STATE}/server.err`,
    ])
    const deadline = Date.now() + 90_000
    // "listening" comes before the server takes requests: a turn sent right then once lost its connection.
    while (Date.now() < deadline) {
      const log = await this.exec(["cat", `${STATE}/server.out`])
      if (/listening on/.test(log.stdout) && (await this.opencode(["session", "list", "--server", SERVER], 30_000)).code === 0) return
      await Bun.sleep(500)
    }
    throw new Error("the server did not start within 90 seconds")
  }

  opencode(args: string[], timeoutMs = 120_000) {
    return this.exec([`${TOOLS}/opencode`, ...args], { timeoutMs })
  }

  async copyOut(from: string, to: string) {
    await docker(["cp", `${this.name}:${from}`, to])
  }

  async remove() {
    await docker(["rm", "-f", this.name])
    containers.running.delete(this.name)
  }
}

/** The largest prompt the session sent, to see how close runs came to the compaction threshold. */
function peakPrompt(data: SessionExport) {
  let peak = 0
  for (const message of data.messages) {
    const tokens = (message as { tokens?: { input: number; cache: { read: number; write: number } } }).tokens
    if (message.type === "assistant" && tokens) peak = Math.max(peak, tokens.input + tokens.cache.read + tokens.cache.write)
  }
  return peak
}

const runDir = (task: Task, model: string, config: string, repeat: number) =>
  path.join(out, `${config}-${model.replace(/[/#]/g, "_")}-${task.id.replace(/^instance_/, "").slice(0, 60)}-${repeat}`)

async function runOne(task: Task, model: string, config: string, repeat: number): Promise<RunResult> {
  const provider = model.split("/")[0] ?? ""
  const root = runDir(task, model, config, repeat)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const steps: RunResult["steps"] = []
  const result: RunResult = { model, config, task: task.id, repeat, ok: false, steps }
  const sandbox = new Sandbox(task.image)
  let sessionID: string | undefined
  try {
    let started = Date.now()
    // A failed download fails this run only. It is done again on the next invocation with the same output directory.
    await pull(task.image)
    await sandbox.start()
    await sandbox.login(await credentialsFor(provider))
    const window = await sandbox.window(model, root)
    if (window <= Number(values.threshold)) throw new Error(`the threshold is above ${model}'s limit of ${window} tokens`)
    result.window = window
    // B runs lodestar. B-T4 and the like run it with one feature switched off, to measure what that feature adds.
    const plugin = config.startsWith("B")
    const disabled = config.match(/^B-(T\d)$/)?.[1]
    const serverConfig = {
      compaction: { buffer: window - Number(values.threshold) },
      lsp: false,
      websearch: false,
      share: "disabled",
      ...(plugin ? { plugins: [PLUGIN] } : {}),
    }
    await sandbox.serve([
      `OPENCODE_CONFIG_CONTENT=${JSON.stringify(serverConfig)}`,
      ...(plugin ? [`LODESTAR_TRACE=${STATE}/trace.jsonl`] : []),
      ...(disabled ? [`LODESTAR_DISABLE=${disabled}`] : []),
    ])
    steps.push({ step: 0, kind: "setup", ms: Date.now() - started })

    started = Date.now()
    const budget = Number(values.budget) * 60
    let turn: Exec = { code: 1, stdout: "", stderr: "", timedOut: false }
    // A connection lost before the session starts costs nothing, so the turn is sent again once.
    for (let attempt = 0; attempt < 2 && !sessionID; attempt++) {
      if (attempt > 0) await Bun.sleep(5_000)
      // Output goes to files inside the container. Through a pipe, a large output was cut off when the process exited.
      turn = await sandbox.exec(
        [
          "sh", "-c", `exec timeout -k 30 "$@" > ${STATE}/turn.jsonl 2> ${STATE}/turn.err`, "sh",
          String(budget), `${TOOLS}/opencode`, "run", "--server", SERVER, "-m", model, "--auto", "--format", "json", task.instruction,
        ],
        { timeoutMs: (budget + 120) * 1000 },
      )
      await sandbox.copyOut(`${STATE}/turn.jsonl`, path.join(root, "turn.jsonl"))
      await sandbox.copyOut(`${STATE}/turn.err`, path.join(root, "turn.err"))
      const events = await Bun.file(path.join(root, "turn.jsonl"))
        .text()
        .catch(() => "")
      for (const line of events.split("\n")) {
        try {
          const event = JSON.parse(line) as { sessionID?: unknown }
          if (typeof event.sessionID === "string" && event.sessionID) sessionID = event.sessionID
        } catch {}
        if (sessionID) break
      }
    }
    const outOfTime = turn.code === 124 || turn.timedOut
    if (outOfTime && sessionID) {
      await sandbox.opencode(["api", "--server", SERVER, "session.interrupt", "--param", `sessionID=${sessionID}`, "-d", "{}"])
      await Bun.sleep(15_000)
    }
    steps.push({ step: 1, kind: "turn", ms: Date.now() - started, detail: outOfTime ? "out of time" : turn.code === 0 ? undefined : `exit ${turn.code}` })
    if (!sessionID || !/^[\w-]+$/.test(sessionID)) throw new Error(`the turn started no session: ${turn.stderr.trim().slice(-500)}`)

    const exported = await sandbox.exec(
      ["sh", "-c", `${TOOLS}/opencode session export --server ${SERVER} ${sessionID} > ${STATE}/export.json`],
      { timeoutMs: 300_000 },
    )
    if (exported.code !== 0) throw new Error(`session export failed: ${exported.stderr.trim().slice(-300)}`)
    await sandbox.copyOut(`${STATE}/export.json`, path.join(root, "export.json"))
    const data = (await Bun.file(path.join(root, "export.json")).json()) as SessionExport

    // The same capture as the benchmark's own agents: everything the agent changed, new files included.
    await sandbox.exec(["sh", "-c", `git add -A >/dev/null 2>&1; git diff --cached > ${STATE}/model.patch; git reset -q`])
    const patch = path.join(root, "model.patch")
    await sandbox.copyOut(`${STATE}/model.patch`, patch)
    // Docker would mount a missing file as an empty directory.
    if (!(await Bun.file(patch).exists())) await Bun.write(patch, "")
    result.patchBytes = Bun.file(patch).size
    if (plugin) {
      await sandbox.copyOut(`${STATE}/trace.jsonl`, path.join(root, "trace.jsonl"))
      const trace = await Bun.file(path.join(root, "trace.jsonl"))
        .text()
        .catch(() => "")
      result.traceLines = trace.split("\n").filter(Boolean).length
    }
    await sandbox.copyOut(`${STATE}/server.err`, path.join(root, "server.err"))

    // A turn that ended in a provider error says nothing about the agent, so the run doesn't count.
    const failed = data.messages.find((message) => message.type === "idle" && "outcome" in message && message.outcome === "failed")
    if (failed) throw new Error(`the turn failed: ${(failed as { error?: { message?: string } }).error?.message ?? "unknown error"}`)
    await sandbox.remove()
    // Measured before grading, so a run whose grading fails can be graded again later with regrade.ts.
    result.metrics = measure(data)
    result.peakPrompt = peakPrompt(data)
    const notes = [outOfTime ? "out of time" : "", result.patchBytes ? "" : "empty patch"].filter(Boolean)
    result.check = { success: false, notes }

    started = Date.now()
    const graded = await grade(task, patch, root)
    steps.push({ step: 2, kind: "grade", ms: Date.now() - started, detail: graded.timedOut ? "timed out" : undefined })
    result.check = { success: graded.success, notes }
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await sandbox.remove()
  }
  await Bun.write(path.join(root, "result.json"), JSON.stringify(result, null, 2))
  return result
}

process.on("SIGINT", stopAll)
process.on("SIGTERM", stopAll)

const taskIDs = values.tasks?.endsWith(".json")
  ? ((await Bun.file(values.tasks).json()) as string[])
  : (values.tasks ?? "").split(",").filter(Boolean)
if (taskIDs.length === 0) throw new Error("pass --tasks with task IDs or a JSON file of them")
if (!(await Bun.file(RIPGREP).exists())) throw new Error(`ripgrep not found at ${RIPGREP}; run any OpenCode search once to download it`)
const tasks = await Promise.all(taskIDs.map((id) => loadTask(values["tasks-dir"], id)))
const models = values.models.split(",")
const configs = values.configs.split(",")
for (const config of configs) if (!/^(A|B|B-T[246])$/.test(config)) throw new Error(`unknown config ${config}`)

await mkdir(out, { recursive: true })
await ensureProxy()
// Runs are grouped by task, so each image is pulled once and can be removed when its task is done.
const jobs = tasks.flatMap((task) =>
  models.flatMap((model) =>
    configs.flatMap((config) => Array.from({ length: Number(values.repeat) }, (_, index) => ({ task, model, config, repeat: index + 1 }))),
  ),
)

/** A run that already counted, from an earlier invocation with the same output directory. */
async function finished(job: (typeof jobs)[number]) {
  const file = Bun.file(path.join(runDir(job.task, job.model, job.config, job.repeat), "result.json"))
  return (await file.exists()) && ((await file.json()) as RunResult).ok
}

// Only runs that haven't counted yet, so images are fetched only for tasks that still have runs to do.
const todo: typeof jobs = []
for (const job of jobs) if (!(await finished(job))) todo.push(job)
const left = new Map(tasks.map((task) => [task.id, todo.filter((job) => job.task === task).length]))
console.log(`${todo.length} of ${jobs.length} runs to do, results in ${out}`)

let next = 0
async function worker() {
  for (;;) {
    const job = todo[next++]
    if (!job || containers.stopping) return
    // The next task's image downloads while this one runs.
    const following = todo.find((other, index) => index >= next && other.task !== job.task)
    if (following) void pull(following.task.image).catch(() => {})
    let result = await runOne(job.task, job.model, job.config, job.repeat)
    // A rate-limited run says nothing about the agent, so wait and run it again. ChatGPT usage limits reset over
    // hours, not minutes, so those get longer waits.
    const limited = () => /rate limit|429|usage limit|limit reached/i.test(result.error ?? "")
    const plan = job.model.startsWith("openai/") ? { attempts: 10, minutes: 30 } : { attempts: 3, minutes: 5 }
    for (let attempt = 1; attempt <= plan.attempts && limited(); attempt++) {
      const wait = job.model.startsWith("openai/") ? plan.minutes : attempt * plan.minutes
      console.log(`${job.config} ${job.model} ${job.task.id}: rate limited, retrying in ${wait} minutes`)
      await Bun.sleep(wait * 60_000)
      result = await runOne(job.task, job.model, job.config, job.repeat)
    }
    await writeResults(out)
    const status = !result.ok ? `error: ${result.error}` : result.check?.success ? "resolved" : "unresolved"
    const minutes = ((result.metrics?.durationMs ?? 0) / 60_000).toFixed(1)
    console.log(
      `${job.config} ${job.model} ${job.task.id.slice(0, 70)}: ${status}, ${minutes} min, compactions ${result.metrics?.compactions ?? "-"}, peak prompt ${result.peakPrompt ?? "-"}`,
    )
    const remaining = (left.get(job.task.id) ?? 1) - 1
    left.set(job.task.id, remaining)
    if (remaining === 0 && values["prune-images"]) await docker(["rmi", job.task.image])
  }
}
try {
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker))
} finally {
  // Containers left by an unexpected error would keep a copy of the credentials.
  await Promise.allSettled([...containers.running].map((name) => docker(["rm", "-f", name])))
}
