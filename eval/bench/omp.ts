// omp (C): print mode on the ChatGPT backend. The access token goes in through an environment variable, so there is no
// stored login and no refresh token anywhere in the container. Settings follow the source of v18.12.6.
import path from "node:path"
import { BIN, STATE } from "./box"
import type { Agent, AgentRun, Context, ToolKind, Trace } from "./types"

const AGENT = `${STATE}/omp/agent`
const SESSIONS = `${STATE}/omp/sessions`
const NATIVES = `${STATE}/omp/natives`

export function ompConfig(threshold: number) {
  return [
    "compaction:",
    "  enabled: true",
    "  methodOrder: [remote]",
    `  thresholdTokens: ${threshold}`,
    "  asyncEnabled: false",
    "  idleEnabled: false",
    "  supersedeReads: false",
    "  dropUseless: false",
    "  experimentalContextManagement: false",
    ...["web_search", "fetch", "browser", "advisor", "lsp", "ttsr", "ask", "goal", "recap", "exa"].map((name) => `${name}: {enabled: false}`),
    "memory: {backend: off}",
    "memories: {enabled: false}",
    "mcp: {enableProjectConfig: false}",
    "skills: {enabled: false}",
    "skillful: false",
    "extensions: []",
    "retry: {modelFallback: false}",
    "features: {unexpectedStopDetection: none}",
    "tools: {intentTracing: false, xdev: false, approvalMode: yolo}",
    "dev: {autoqa: false}",
    "providers: {cacheWarming: off}",
    "magicKeywords: {enabled: false}",
    "startup: {checkUpdate: false}",
    "telemetry: {otlpExportEnabled: false}",
    "astEdit: {enabled: false}",
    "shellMinimizer: {enabled: false}",
    "read: {summarize: {enabled: false}}",
    "disabledProviders: [native, claude, codex, gemini, opencode, github, agents, agents-md, claude-md, custom-context, cursor, windsurf, cline, vscode, mcp-json]",
    "",
  ].join("\n")
}

const KINDS: Record<string, ToolKind> = { read: "read", edit: "edit", write: "edit", bash: "shell", grep: "search", glob: "search" }

export function ompAgent(): Agent {
  const env = (ctx: Context) => [
    `PI_CODING_AGENT_DIR=${AGENT}`,
    `PI_NATIVES_DIR=${NATIVES}`,
    `OPENAI_CODEX_OAUTH_TOKEN=${ctx.login.access}`,
    "NODE_EXTRA_CA_CERTS=/opt/bench/ca.pem",
    "PI_NO_TITLE=1",
    ...(ctx.box.musl ? ["LD_LIBRARY_PATH=/opt/bench/omp/musl-libs"] : []),
  ]
  return {
    id: "C",
    label: "omp",
    async setup(ctx) {
      await ctx.box.exec(["mkdir", "-p", AGENT, SESSIONS, NATIVES])
      await ctx.box.write(`${STATE}/omp/config.yml`, ompConfig(ctx.threshold))
    },
    async run(ctx): Promise<AgentRun> {
      await ctx.box.write(`${STATE}/prompt.md`, ctx.task.instruction)
      const startedAt = Date.now() / 1000
      const turn = await ctx.box.exec(
        ["sh", "-c", `exec timeout -k 30 ${ctx.budget} ${BIN}/omp -p --mode json --model openai-codex/${ctx.model} --thinking ${ctx.effort} --tools read,bash,edit,write,grep,glob --auto-approve --session-dir ${SESSIONS} --no-title --no-skills --no-rules --no-extensions --no-lsp --config ${STATE}/omp/config.yml < ${STATE}/prompt.md > ${STATE}/events.jsonl 2> ${STATE}/events.err`],
        { env: env(ctx), timeoutMs: (ctx.budget + 120) * 1000 },
      )
      return { startedAt, endedAt: Date.now() / 1000, outOfTime: turn.code === 124 || turn.code === 137 || turn.timedOut, exitCode: turn.code }
    },
    async collect(ctx) {
      for (const file of ["events.jsonl", "events.err"]) await ctx.box.copyOut(`${STATE}/${file}`, path.join(ctx.root, file))
      const found = await ctx.box.exec(["sh", "-c", `find ${SESSIONS} -name '*.jsonl' | head -n 1`])
      const session = found.stdout.trim()
      if (!session) throw new Error("omp wrote no session")
      await ctx.box.copyOut(session, path.join(ctx.root, "session.jsonl"))
    },
    async trace(root): Promise<Trace> {
      return ompTrace(await Bun.file(path.join(root, "session.jsonl")).text())
    },
  }
}

export function ompTrace(session: string): Trace {
  const trace: Trace = []
  const results = new Map<string, boolean>()
  const entries = session.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, any>]
    } catch {
      return []
    }
  })
  for (const entry of entries) if (entry.type === "message" && entry.message?.role === "toolResult") results.set(entry.message.toolCallId, !entry.message.isError)
  for (const entry of entries) {
    if (entry.type === "compaction") trace.push({ type: "compaction", method: String(entry.method ?? "unknown"), tokensBefore: entry.tokensBefore, tokensAfter: entry.tokensAfter })
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue
    for (const block of entry.message.content ?? []) {
      if (block.type !== "toolCall") continue
      const args = block.arguments ?? {}
      const file = args.path ?? args.file_path ?? args.filePath
      trace.push({ type: "tool", name: block.name, kind: KINDS[block.name] ?? "other", file: typeof file === "string" ? file : undefined, command: typeof args.command === "string" ? args.command : undefined, ok: results.get(block.id) ?? true })
    }
  }
  return trace
}
