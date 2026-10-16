import { mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import type { CompactionMessage, SessionExport } from "./session"

export const OPENCODE = process.env.OPENCODE_BIN ?? path.join(homedir(), ".opencode/bin/opencode")

export interface CliResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

// Runs an opencode command. stdin must stay closed: `opencode run` waits for EOF when stdin is not a terminal.
async function cli(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; stdin?: Uint8Array },
): Promise<CliResult> {
  const proc = Bun.spawn([OPENCODE, ...args], {
    cwd: options.cwd,
    // OpenCode takes the session directory from PWD, not from the process's working directory.
    env: { ...options.env, PWD: options.cwd },
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGTERM")
  }, options.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}

/**
 * The user's environment without OpenCode settings, so nothing from their own setup leaks into a run.
 * BUN_BE_BUN is dropped too: when this script runs on the Bun inside OpenCode, it would turn opencode into bun.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "BUN_BE_BUN" || key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  return env
}

/** Reads one integration's credentials from the user's own OpenCode. The bytes stay in memory. */
export async function exportCredentials(integration: string): Promise<Uint8Array> {
  const result = await cli(["auth", "export", integration, "--standalone"], {
    cwd: homedir(),
    env: { ...baseEnv(), OPENCODE_DISABLE_AUTOUPDATE: "1" },
    timeoutMs: 120_000,
  })
  if (result.code !== 0) throw new Error(`auth export failed: ${result.stderr.trim()}`)
  return new TextEncoder().encode(result.stdout)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("could not find a free port"))
      })
    })
  })
}

export interface InstanceOptions {
  /** Directory for this run. Isolated XDG dirs and server logs go under it. */
  root: string
  /** The project the agent works in. */
  workdir: string
  /** Server config, passed as OPENCODE_CONFIG_CONTENT. */
  config: Record<string, unknown>
  /** Extra environment for the server, such as the plugin's eval switches. */
  env?: Record<string, string>
  /** Prepended to PATH, for example a directory holding a `bun` wrapper for the agent's shell. */
  pathPrefix?: string
}

/** One OpenCode server with its own data, config, state, and cache dirs. Nothing touches the user's setup. */
export class Instance {
  url = ""
  private server?: Bun.Subprocess
  private readonly password = crypto.randomUUID()
  private readonly xdg: Record<string, string>

  constructor(private readonly options: InstanceOptions) {
    const base = path.join(options.root, "xdg")
    this.xdg = {
      XDG_DATA_HOME: path.join(base, "data"),
      XDG_CONFIG_HOME: path.join(base, "config"),
      XDG_STATE_HOME: path.join(base, "state"),
      XDG_CACHE_HOME: path.join(base, "cache"),
    }
  }

  private env(extra: Record<string, string> = {}): Record<string, string> {
    const base = baseEnv()
    return {
      ...base,
      ...this.xdg,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_PASSWORD: this.password,
      PATH: [this.options.pathPrefix, base.PATH].filter(Boolean).join(":"),
      ...extra,
    }
  }

  private run(args: string[], timeoutMs: number, stdin?: Uint8Array) {
    return cli(args, { cwd: this.options.workdir, env: this.env(), timeoutMs, stdin })
  }

  /** Creates the isolated dirs and copies the credentials into them. */
  async setup(credentials: Uint8Array) {
    for (const dir of Object.values(this.xdg)) await mkdir(dir, { recursive: true })
    const result = await this.run(["auth", "import", "--standalone"], 120_000, credentials)
    if (result.code !== 0) throw new Error(`auth import failed: ${result.stderr.trim()}`)
  }

  async start() {
    const port = await freePort()
    const out = path.join(this.options.root, "server.out")
    this.server = Bun.spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: this.options.workdir,
      env: this.env({
        ...this.options.env,
        PWD: this.options.workdir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(this.options.config),
      }),
      stdin: "ignore",
      stdout: Bun.file(out),
      stderr: Bun.file(path.join(this.options.root, "server.err")),
    })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const text = await Bun.file(out)
        .text()
        .catch(() => "")
      const match = text.match(/listening on (http:\/\/\S+)/)
      if (match?.[1]) {
        this.url = match[1]
        return
      }
      if (this.server.exitCode !== null) throw new Error(`server exited with code ${this.server.exitCode}`)
      await Bun.sleep(250)
    }
    throw new Error("server did not start within 60 seconds")
  }

  /** Sends one user message and waits for the agent to finish. Returns the session ID. */
  async turn(input: { sessionID?: string; model: string; message: string; timeoutMs: number }) {
    const args = ["run", "--server", this.url, "-m", input.model, "--auto", "--format", "json"]
    if (input.sessionID) args.push("-s", input.sessionID)
    args.push(input.message)
    const result = await this.run(args, input.timeoutMs)
    let sessionID = input.sessionID
    for (const line of result.stdout.split("\n")) {
      if (sessionID) break
      try {
        const event = JSON.parse(line) as { sessionID?: unknown }
        if (typeof event.sessionID === "string") sessionID = event.sessionID
      } catch {}
    }
    if (result.timedOut && sessionID) await this.interrupt(sessionID)
    return { ...result, sessionID }
  }

  async interrupt(sessionID: string) {
    await this.run(["api", "--server", this.url, "session.interrupt", "--param", `sessionID=${sessionID}`, "-d", "{}"], 60_000)
  }

  /** Asks the server to compact the session and waits until the compaction settles. */
  async compact(sessionID: string, timeoutMs: number): Promise<CompactionMessage> {
    const result = await this.run(
      ["api", "--server", this.url, "session.compact", "--param", `sessionID=${sessionID}`, "-d", "{}"],
      60_000,
    )
    if (result.code !== 0) throw new Error(`compact request failed: ${result.stderr.trim()}`)
    const id = (JSON.parse(result.stdout) as { data: { id: string } }).data.id
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await Bun.sleep(2000)
      const data = await this.export(sessionID)
      const index = data.messages.findIndex((message) => message.id === id)
      const message = data.messages[index] as CompactionMessage | undefined
      if (!message) continue
      const settled = message.status === "completed" || message.status === "failed"
      if (settled && data.messages.slice(index + 1).some((next) => next.type === "idle")) return message
    }
    throw new Error("compaction did not finish in time")
  }

  async export(sessionID: string): Promise<SessionExport> {
    const result = await this.run(["session", "export", "--server", this.url, sessionID], 120_000)
    if (result.code !== 0) throw new Error(`session export failed: ${result.stderr.trim()}`)
    return JSON.parse(result.stdout) as SessionExport
  }

  async stop() {
    if (!this.server) return
    this.server.kill("SIGTERM")
    await this.server.exited
  }

  /** Removes the isolated dirs. They hold a copy of the credentials. */
  async cleanup() {
    await rm(path.join(this.options.root, "xdg"), { recursive: true, force: true })
  }
}
