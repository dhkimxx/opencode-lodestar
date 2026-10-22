// OpenCode alone (A) and with lodestar (B), run the way the lodestar evaluation does: a server inside the task
// container, `opencode run` against it, and the session exported at the end.
import path from "node:path"
import { isAssistant, type SessionExport } from "../lib/session"
import { BIN, STATE } from "./box"
import type { Agent, AgentRun, Context, Login, ToolKind, Trace } from "./types"

const SERVER = "http://127.0.0.1:4096"
const PLUGIN = "/opt/bench/lodestar"
const XDG = `${STATE}/opencode`
const NODE_CA = "NODE_EXTRA_CA_CERTS=/opt/bench/ca.pem"

/** The login in OpenCode's own export format, without a usable refresh token. */
export function opencodeCredentials(login: Login): Uint8Array {
  const entry = {
    id: "cred_bench",
    integrationID: "openai",
    label: "bench",
    active: true,
    value: { type: "oauth", methodID: "chatgpt-headless", refresh: "unusable", access: login.access, expires: login.expires, metadata: { accountID: login.accountID } },
  }
  return new TextEncoder().encode(JSON.stringify([entry]))
}

const KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  multiedit: "edit",
  shell: "shell",
  bash: "shell",
  grep: "search",
  glob: "search",
  list: "search",
}

export function openCodeAgent(id: "A" | "B"): Agent {
  const plugin = id === "B"
  const xdg = [`XDG_DATA_HOME=${XDG}/data`, `XDG_CONFIG_HOME=${XDG}/config`, `XDG_STATE_HOME=${XDG}/state`, `XDG_CACHE_HOME=${XDG}/cache`]
  const password = crypto.randomUUID()
  const env = (_ctx: Context) => [...xdg, NODE_CA, "OPENCODE_DISABLE_AUTOUPDATE=1", `OPENCODE_PASSWORD=${password}`]

  async function window(ctx: Context) {
    const listed = await ctx.box.exec(["sh", "-c", `${BIN}/opencode api model.list --standalone > ${STATE}/models.json`], { env: env(ctx), timeoutMs: 120_000 })
    if (listed.code !== 0) throw new Error(`model list failed: ${listed.stderr.trim().slice(-300)}`)
    await ctx.box.copyOut(`${STATE}/models.json`, path.join(ctx.root, "models.json"))
    const data = (await Bun.file(path.join(ctx.root, "models.json")).json()) as unknown
    type Listed = { providerID?: string; id?: string; limit?: { context?: number; input?: number } }
    const list = (Array.isArray(data) ? data : (data as { data?: unknown }).data) as Listed[] | undefined
    const found = list?.find((entry) => entry.providerID === "openai" && entry.id === ctx.model)
    const size = found?.limit?.input || found?.limit?.context
    if (!size) throw new Error(`no limits listed for openai/${ctx.model}`)
    return size
  }

  return {
    id,
    label: plugin ? "OpenCode + lodestar" : "OpenCode",
    async setup(ctx) {
      await ctx.box.exec(["mkdir", "-p", ...["data", "config", "state", "cache"].map((dir) => `${XDG}/${dir}`)])
      const imported = await ctx.box.exec([`${BIN}/opencode`, "auth", "import", "--standalone"], {
        stdin: opencodeCredentials(ctx.login),
        env: env(ctx),
        timeoutMs: 120_000,
      })
      if (imported.code !== 0) throw new Error(`auth import failed: ${imported.stderr.trim().slice(-300)}`)
    },

    async run(ctx): Promise<AgentRun> {
      const size = await window(ctx)
      if (size <= ctx.threshold) throw new Error(`the threshold ${ctx.threshold} is above the model's limit of ${size}`)
      // OpenCode compacts when the context reaches the window minus this buffer. The context is the prompt the last
      // step sent, which is also what the other harnesses compare with their own limits.
      const config = {
        compaction: { buffer: size - ctx.threshold },
        lsp: false,
        websearch: false,
        share: "disabled",
        ...(plugin ? { plugins: [PLUGIN] } : {}),
      }
      const serverEnv = [...env(ctx), `OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`, ...(plugin ? [`LODESTAR_TRACE=${STATE}/trace.jsonl`] : [])]
      await ctx.box.spawn(`exec ${BIN}/opencode serve --hostname 127.0.0.1 --port 4096 > ${STATE}/server.out 2> ${STATE}/server.err`, serverEnv)
      const deadline = Date.now() + 90_000
      for (;;) {
        const log = await ctx.box.exec(["cat", `${STATE}/server.out`])
        const listing = /listening on/.test(log.stdout) ? await ctx.box.exec([`${BIN}/opencode`, "session", "list", "--server", SERVER], { env: serverEnv, timeoutMs: 30_000 }) : undefined
        if (listing?.code === 0) break
        if (Date.now() > deadline) throw new Error("the server did not start within 90 seconds")
        await Bun.sleep(500)
      }

      const startedAt = Date.now() / 1000
      const prompt = ctx.task.instruction
      await ctx.box.write(`${STATE}/prompt.md`, prompt)
      const turn = await ctx.box.exec(
        ["sh", "-c", `exec timeout -k 30 ${ctx.budget} ${BIN}/opencode run --server ${SERVER} -m openai/${ctx.model}#${ctx.effort} --auto --format json "$(cat ${STATE}/prompt.md)" > ${STATE}/turn.jsonl 2> ${STATE}/turn.err`],
        { env: serverEnv, timeoutMs: (ctx.budget + 120) * 1000 },
      )
      const endedAt = Date.now() / 1000
      const outOfTime = turn.code === 124 || turn.timedOut
      return { startedAt, endedAt, outOfTime, exitCode: turn.code }
    },

    async collect(ctx) {
      for (const file of ["turn.jsonl", "turn.err", "server.err", ...(plugin ? ["trace.jsonl"] : [])]) await ctx.box.copyOut(`${STATE}/${file}`, path.join(ctx.root, file))
      const events = await Bun.file(path.join(ctx.root, "turn.jsonl")).text().catch(() => "")
      let sessionID: string | undefined
      for (const line of events.split("\n")) {
        try {
          const found = (JSON.parse(line) as { sessionID?: unknown }).sessionID
          if (typeof found === "string" && found) sessionID = found
        } catch {}
        if (sessionID) break
      }
      if (!sessionID || !/^[\w-]+$/.test(sessionID)) throw new Error(`the turn started no session: ${(await Bun.file(path.join(ctx.root, "turn.err")).text().catch(() => "")).slice(-300)}`)
      const env2 = env(ctx)
      await ctx.box.exec([`${BIN}/opencode`, "api", "--server", SERVER, "session.interrupt", "--param", `sessionID=${sessionID}`, "-d", "{}"], { env: env2, timeoutMs: 60_000 }).catch(() => {})
      const exported = await ctx.box.exec(["sh", "-c", `${BIN}/opencode session export --server ${SERVER} ${sessionID} > ${STATE}/export.json`], { env: env2, timeoutMs: 300_000 })
      if (exported.code !== 0) throw new Error(`session export failed: ${exported.stderr.trim().slice(-300)}`)
      await ctx.box.copyOut(`${STATE}/export.json`, path.join(ctx.root, "export.json"))
    },

    async trace(root): Promise<Trace> {
      const data = (await Bun.file(path.join(root, "export.json")).json()) as SessionExport
      const events: Trace = []
      const started = data.info.time.created
      for (const message of data.messages) {
        if (message.type === "compaction") {
          const tokens = (message as { tokens?: { input: number; cache: { read: number; write: number } } }).tokens
          events.push({ type: "compaction", method: "summary", at: (message.time.created - started) / 1000, tokensBefore: tokens ? tokens.input + tokens.cache.read + tokens.cache.write : undefined })
        }
        if (!isAssistant(message)) continue
        for (const part of message.content) {
          if (part.type !== "tool") continue
          const tool = part as import("../lib/session").ToolPart
          const input = tool.state.input ?? {}
          const file = input.path ?? input.filePath
          events.push({
            type: "tool",
            name: tool.name,
            kind: KINDS[tool.name] ?? "other",
            file: typeof file === "string" ? file : undefined,
            command: typeof input.command === "string" ? input.command : undefined,
            ok: tool.state.status === "completed",
          })
        }
      }
      return events
    },
  }
}
