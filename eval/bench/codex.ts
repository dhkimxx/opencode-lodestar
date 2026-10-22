// Codex CLI (D): `codex exec` on the ChatGPT backend, with the login written as Codex's own auth.json but without a
// refresh token that works. Settings follow the source of rust-v0.163.0.
import path from "node:path"
import { BIN, STATE } from "./box"
import type { Agent, AgentRun, Context, ToolKind, Trace } from "./types"

const HOME = `${STATE}/codex`

export function codexConfig(model: string, effort: string, threshold: number) {
  return [
    `model = "${model}"`,
    `model_reasoning_effort = "${effort}"`,
    `model_reasoning_summary = "none"`,
    `model_auto_compact_token_limit = ${threshold}`,
    `web_search = "disabled"`,
    `project_doc_max_bytes = 0`,
    `forced_login_method = "chatgpt"`,
    `cli_auth_credentials_store = "file"`,
    `check_for_update_on_startup = false`,
    `model_catalog_json = "${HOME}/models.json"`,
    `service_tier = "default"`,
    `[agents]`, `enabled = false`,
    `[features]`, ...["multi_agent", "multi_agent_v2", "apps", "plugins", "goals", "image_generation", "memories", "tool_suggest"].map((name) => `${name} = false`),
    `[analytics]`, `enabled = false`,
    `[feedback]`, `enabled = false`,
    `[otel]`, `exporter = "none"`, `metrics_exporter = "none"`, `trace_exporter = "none"`,
    `[history]`, `persistence = "none"`,
    `[memories]`, `generate_memories = false`, `use_memories = false`,
    `[shell_environment_policy]`, `inherit = "all"`,
    "",
  ].join("\n")
}

export function codexAuth(login: { access: string; accountID: string }) {
  // The access token is a JWT with the claims Codex reads from an ID token, so it stands in for one.
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: login.access, access_token: login.access, refresh_token: "unusable-no-refresh", account_id: login.accountID },
    last_refresh: new Date().toISOString(),
  })
}

export function codexAgent(): Agent {
  const env = ["CODEX_HOME=" + HOME, "CODEX_CA_CERTIFICATE=/opt/bench/ca.pem", "CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://127.0.0.1:9/"]
  return {
    id: "D",
    label: "Codex",
    async setup(ctx) {
      await ctx.box.write(`${HOME}/auth.json`, codexAuth(ctx.login))
      await ctx.box.write(`${HOME}/config.toml`, codexConfig(ctx.model, ctx.effort, ctx.threshold))
      // The catalog that ships with this release: no network, and the same on every run.
      const made = await ctx.box.exec(["sh", "-c", `codex debug models --bundled > ${HOME}/models.json`], { env })
      if (made.code !== 0) throw new Error(`codex debug models failed: ${made.stderr.trim().slice(-300)}`)
      // Codex finds codex-code-mode-host next to its own binary.
      await ctx.box.exec(["sh", "-c", `ln -sf /opt/bench/codex/codex-code-mode-host ${BIN}/codex-code-mode-host`])
    },
    async run(ctx): Promise<AgentRun> {
      await ctx.box.write(`${STATE}/prompt.md`, ctx.task.instruction)
      const startedAt = Date.now() / 1000
      const turn = await ctx.box.exec(
        ["sh", "-c", `exec timeout -s INT -k 30 ${ctx.budget} ${BIN}/codex exec --json --strict-config --skip-git-repo-check -C ${ctx.box.workdir} --dangerously-bypass-approvals-and-sandbox - < ${STATE}/prompt.md > ${STATE}/events.jsonl 2> ${STATE}/events.err`],
        { env, timeoutMs: (ctx.budget + 120) * 1000 },
      )
      return { startedAt, endedAt: Date.now() / 1000, outOfTime: turn.code === 124 || turn.code === 137 || turn.timedOut, exitCode: turn.code }
    },
    async collect(ctx) {
      for (const file of ["events.jsonl", "events.err"]) await ctx.box.copyOut(`${STATE}/${file}`, path.join(ctx.root, file))
      const found = await ctx.box.exec(["sh", "-c", `find ${HOME}/sessions -name 'rollout-*.jsonl' | head -n 1`])
      const rollout = found.stdout.trim()
      if (!rollout) throw new Error("codex wrote no rollout")
      await ctx.box.copyOut(rollout, path.join(ctx.root, "rollout.jsonl"))
    },
    async trace(root): Promise<Trace> {
      return codexTrace(await Bun.file(path.join(root, "events.jsonl")).text(), await Bun.file(path.join(root, "rollout.jsonl")).text())
    },
  }
}

const parse = (text: string) =>
  text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, any>]
    } catch {
      return []
    }
  })

/**
 * Tool calls come from the events `codex exec --json` prints, where each command and each file change is an item. The
 * rollout adds the compactions, and the model's own `exec` calls, which run several tools from one piece of JavaScript.
 */
export function codexTrace(events: string, rollout: string): Trace {
  const trace: Trace = []
  const items = new Map<string, Record<string, any>>()
  for (const event of parse(events)) {
    if (event.type !== "item.completed" || !event.item) continue
    items.set(event.item.id ?? String(items.size), event.item)
  }
  const compactionsAt = parse(rollout).filter((entry) => entry.type === "compacted").length
  for (const item of items.values()) {
    if (item.type === "command_execution") trace.push({ type: "tool", name: "command", kind: "shell" as ToolKind, command: String(item.command ?? ""), ok: item.status === "completed" && (item.exit_code ?? 0) === 0 })
    else if (item.type === "file_change") for (const change of item.changes ?? [{ path: undefined }]) trace.push({ type: "tool", name: "apply_patch", kind: "edit", file: change.path, ok: item.status === "completed" })
    else if (item.type === "mcp_tool_call" || item.type === "collab_tool_call" || item.type === "web_search") trace.push({ type: "tool", name: item.type, kind: "other", ok: item.status === "completed" })
  }
  // The rollout doesn't say where in the run each compaction fell, so they come last. The re-read count after a
  // compaction therefore leaves Codex out unless events carry the order; the table says so.
  for (let index = 0; index < compactionsAt; index++) trace.push({ type: "compaction", method: "remote" })
  return trace
}
