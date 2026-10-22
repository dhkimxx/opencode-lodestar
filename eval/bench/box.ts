// A task container for the harness benchmark: the task's own image, the harnesses' binaries mounted read-only, and one
// way out, the metering proxy. Every harness runs in a container made this way.
import { homedir } from "node:os"
import path from "node:path"
import { containers, docker, launch, must, type Exec } from "../lib/docker"
import { OPENCODE } from "../lib/opencode"

export const NETWORK = "lodestar-bench"
export const PROXY = "lodestar-bench-proxy"
export const PROXY_URL = `http://${PROXY}:8080`
export const CACHE = path.join(homedir(), ".cache/lodestar-eval")
/** Where the meter keeps its log and the proxy keeps its certificate authority. */
export const METER_DIR = path.join(CACHE, "bench/meter")
export const CA_DIR = path.join(CACHE, "bench/ca")
export const CA_CERT = path.join(CA_DIR, "mitmproxy-ca-cert.pem")
/** The harnesses, at the releases the benchmark was planned for. */
export const CODEX_DIR = path.join(CACHE, "bin/codex-0.163.0")
export const OMP_DIR = path.join(CACHE, "bin/omp-18.12.6")
export const RIPGREP = path.join(homedir(), ".cache/opencode/bin/rg")

/** Inside every container. */
export const MOUNTS = "/opt/bench"
export const BIN = `${MOUNTS}/bin`
export const STATE = "/tmp/bench"

/** Hosts the agents may reach. The ChatGPT backend only: nothing can refresh a token at auth.openai.com. */
export const ALLOWED_HOSTS = ["chatgpt.com"]

export interface Mounts {
  /** A lodestar checkout, for the harness that runs it. */
  plugin?: string
}

/** One task container, with what every harness needs: the tools, the proxy, and the proxy's certificate. */
export class Box {
  readonly name = `lodestar-bench-${crypto.randomUUID().slice(0, 8)}`
  /** Environment for every command run inside, set once the container is up. */
  env: string[] = []
  workdir = "/app"
  musl = false
  ip = ""
  /** When the container came up, in seconds. Addresses are reused, so the meter's lines are told apart by time. */
  startedAt = 0

  constructor(
    private readonly image: string,
    private readonly mounts: Mounts & { opencodeMusl: string },
  ) {}

  async start() {
    this.startedAt = Date.now() / 1000
    const imageEnv = JSON.parse((await must(["image", "inspect", "-f", "{{json .Config.Env}}", this.image])).stdout) as string[]
    const imagePath = imageEnv.find((entry) => entry.startsWith("PATH="))?.slice(5) ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    const mount = (from: string, to: string) => ["-v", `${from}:${MOUNTS}/${to}:ro`]
    const started = await launch(this.name, [
      "-d", "--network", NETWORK, "--memory", "6g", "--cpus", "2",
      ...mount(OPENCODE, "opencode-glibc"), ...mount(this.mounts.opencodeMusl, "opencode-musl"),
      ...mount(RIPGREP, "rg"), ...mount(CODEX_DIR, "codex"), ...mount(OMP_DIR, "omp"), ...mount(CA_CERT, "ca.pem"),
      ...(this.mounts.plugin ? mount(this.mounts.plugin, "lodestar") : []),
      "--entrypoint", "tail", this.image, "-f", "/dev/null",
    ])
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr.trim().slice(-500)}`)
    // Some task images are Alpine, where only the musl builds run.
    const libc = (await this.exec(["sh", "-c", "[ -e /lib/ld-musl-x86_64.so.1 ] && echo musl || echo glibc"], { workdir: "/" })).stdout.trim()
    this.musl = libc === "musl"
    const linked = await this.exec(
      [
        "sh", "-c",
        `mkdir -p ${BIN} && ln -sf ${MOUNTS}/opencode-${libc} ${BIN}/opencode && ln -sf ${MOUNTS}/rg ${BIN}/rg && ln -sf ${MOUNTS}/codex/codex ${BIN}/codex && ln -sf ${MOUNTS}/omp/omp-${libc} ${BIN}/omp`,
      ],
      { workdir: "/" },
    )
    if (linked.code !== 0) throw new Error(`could not link the harnesses: ${linked.stderr.trim().slice(-300)}`)
    this.workdir = (await this.exec(["sh", "-c", "if [ -d /app/.git ]; then echo /app; elif [ -d /testbed ]; then echo /testbed; else echo /; fi"], { workdir: "/" })).stdout.trim()
    this.ip = (await must(["inspect", "-f", `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, this.name])).stdout.trim()
    this.env = [
      `PATH=${BIN}:${imagePath}`,
      `PWD=${this.workdir}`,
      `HOME=${STATE}/home`,
      ...["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map((key) => `${key}=${PROXY_URL}`),
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
    ]
    await this.exec(["mkdir", "-p", `${STATE}/home`])
  }

  exec(command: string[], options: { stdin?: Uint8Array; timeoutMs?: number; workdir?: string; env?: string[] } = {}): Promise<Exec> {
    const env = [...this.env, ...(options.env ?? [])].flatMap((entry) => ["-e", entry])
    return docker(["exec", ...(options.stdin ? ["-i"] : []), "-w", options.workdir ?? this.workdir, ...env, this.name, ...command], options)
  }

  /** Runs a shell command in the background, so a long run isn't tied to this process's pipe. */
  async spawn(script: string, env: string[] = []) {
    const flags = [...this.env, ...env].flatMap((entry) => ["-e", entry])
    await must(["exec", "-d", "-w", this.workdir, ...flags, this.name, "sh", "-c", script])
  }

  async write(to: string, content: string | Uint8Array, mode = "600") {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
    const written = await this.exec(["sh", "-c", `mkdir -p "$(dirname ${to})" && cat > ${to} && chmod ${mode} ${to}`], { stdin: bytes, workdir: "/" })
    if (written.code !== 0) throw new Error(`could not write ${to}: ${written.stderr.trim().slice(-200)}`)
  }

  async copyOut(from: string, to: string) {
    await docker(["cp", `${this.name}:${from}`, to])
  }

  async remove() {
    await docker(["rm", "-f", this.name])
    containers.running.delete(this.name)
  }
}

/** The internal network and the proxy that is its only way out. The proxy meters every request and refuses other hosts. */
export async function ensureProxy() {
  if ((await docker(["network", "inspect", NETWORK])).code !== 0) await must(["network", "create", "--internal", NETWORK])
  const meter = path.join(import.meta.dir, "meter.py")
  const wanted = `${ALLOWED_HOSTS.join(",")}`
  const current = await docker(["inspect", "-f", "{{.State.Running}} {{range .Config.Env}}{{println .}}{{end}}", PROXY])
  if (current.stdout.startsWith("true") && current.stdout.includes(`METER_ALLOW=${wanted}`)) return
  await docker(["rm", "-f", PROXY])
  await Bun.$`mkdir -p ${CA_DIR} ${METER_DIR}`.quiet()
  await must([
    "run", "-d", "--name", PROXY, "-e", `METER_ALLOW=${wanted}`, "-e", "METER_OUT=/meter/meter.jsonl",
    "-v", `${CA_DIR}:/home/mitmproxy/.mitmproxy`, "-v", `${METER_DIR}:/meter`, "-v", `${meter}:/meter.py:ro`,
    "mitmproxy/mitmproxy:latest", "mitmdump", "-s", "/meter.py", "--listen-port", "8080", "--set", "connection_strategy=lazy",
  ])
  await must(["network", "connect", NETWORK, PROXY])
  const deadline = Date.now() + 30_000
  while (!(await Bun.file(CA_CERT).exists()) && Date.now() < deadline) await Bun.sleep(500)
  if (!(await Bun.file(CA_CERT).exists())) throw new Error("the proxy made no certificate authority")
}

/** What the meter recorded for one container, by its address on the benchmark's network. */
export interface Metered {
  t: number
  ip: string
  host: string
  kind: "http" | "ws"
  event: "request" | "response" | "denied"
  path?: string
  status?: number
  model?: string
  effort?: string
  tier?: string
  items?: number
  tools?: number
  instructions_chars?: number
  body_bytes?: number
  id?: string
  usage?: { input: number | null; cached: number | null; output: number | null; reasoning: number | null }
}

export async function meteredFor(ip: string, since: number, until: number): Promise<Metered[]> {
  const text = await Bun.file(path.join(METER_DIR, "meter.jsonl")).text().catch(() => "")
  const lines: Metered[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as Metered
      if (entry.ip === ip && entry.t >= since && entry.t <= until) lines.push(entry)
    } catch {}
  }
  return lines
}
