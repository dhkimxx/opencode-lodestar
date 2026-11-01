// A smoke test of lodestar against a real OpenCode and a scripted model, with no model provider and no tokens spent.
//
// usage: bun eval/smoke.ts [--opencode <binary>] [--plugin <lodestar checkout>] [--keep]
//
// A local OpenAI-compatible server plays the model: it reads and edits files in a throwaway project by a fixed script,
// answers OpenCode's summary requests with a summary, and records every request. OpenCode runs in throwaway folders
// with lodestar from this checkout and compacts at 30,000 tokens. The checks then read the recorded requests and
// lodestar's trace: where the restoration goes, what it holds, whether compaction requests keep the cached prefix, and
// whether the budget follows the provider's count. Requests to anything but the local server are refused.
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { opencode: { type: "string" }, plugin: { type: "string" }, keep: { type: "boolean", default: false } },
})
const OPENCODE = values.opencode ?? process.env.OPENCODE_BIN ?? path.join(homedir(), ".opencode/bin/opencode")
const REPO = path.resolve(values.plugin ?? path.join(import.meta.dir, ".."))
const WINDOW = 64_000
const COMPACT_AT = 30_000
const FILES = 8
const STEPS = 60
/** Few enough that the files the agent changed leave room in the restoration for the code it read. */
const EDITS = 2
const TASK = "Set each marker in src/ to 1, one file at a time, and read the other files to check that nothing else uses them."

type Message = { role: string; content?: unknown; tool_calls?: unknown }
type Body = { messages: Message[]; tools?: unknown[] }
/** `same` is how many leading messages repeat the previous request's, of `previous` it had. */
type Recorded = { kind: "agent" | "summary" | "other"; body: Body; prompt: number; cached: number; same: number; previous: number }

const text = (message: Message | undefined): string => {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}
const tokens = (value: unknown) => Math.ceil(JSON.stringify(value ?? null).length / 4)

// The throwaway project: files of about 1,000 tokens, each with one marker to change. Small enough that lodestar can
// bring back what was read, and that compactions come several steps apart, as they do in real sessions.
const root = await mkdtemp(path.join(tmpdir(), "lodestar-smoke-"))
const project = path.join(root, "project")
await mkdir(path.join(project, "src"), { recursive: true })
const files = Array.from({ length: FILES }, (_, index) => `src/file${index}.ts`)
for (const [index, file] of files.entries()) {
  const filler = Array.from({ length: 64 }, (_, line) => `export const value${index}_${line} = "${"x".repeat(32)}"`).join("\n")
  await writeFile(path.join(project, file), `export const marker${index} = 0\n${filler}\n`)
}
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.com", ...args], { cwd: project, stdio: "pipe" })
git("init", "-q")
git("add", "-A")
git("commit", "-qm", "start")

// The script: read a file at every step, and edit one every sixth step, then answer.
let step = 0
let edits = 0
function nextAction(): { tool?: { name: string; input: Record<string, string> }; text?: string } {
  const at = step++
  if (at >= STEPS) return { text: "Done. Every marker I reached is set to 1." }
  if (at % 6 === 3 && edits < EDITS) {
    const index = edits++
    return { tool: { name: "edit", input: { path: path.join(project, files[index]!), oldString: `export const marker${index} = 0`, newString: `export const marker${index} = 1` } } }
  }
  return { tool: { name: "read", input: { path: path.join(project, files[at % FILES]!) } } }
}

// Each summary differs, as a model's would, so each compaction gets its own checkpoint.
let summaries = 0
const summary = () => [
  "## Objective",
  `- Set each marker in src/ to 1. This is summary ${++summaries}.`,
  "",
  "## Work State",
  "### Completed",
  "- Some markers are set.",
  "### Active",
  "- Setting the rest.",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. Continue with the next file.",
  "",
  "## Relevant Files",
  "- `src/`: the files with markers",
].join("\n")

const recorded: Recorded[] = []
function sse(chunks: unknown[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.endsWith("/chat/completions")) return Response.json({ data: [] })
    const body = (await request.json()) as Body
    const last = body.messages.at(-1)
    const kind: Recorded["kind"] = text(last).includes("You MUST use this format") ? "summary" : body.tools?.length ? "agent" : "other"
    // The provider caches the longest prefix of messages the previous request also sent.
    const previous = recorded.at(-1)?.body.messages ?? []
    let same = 0
    while (same < previous.length && same < body.messages.length && JSON.stringify(previous[same]) === JSON.stringify(body.messages[same])) same++
    const prompt = tokens(body.messages) + tokens(body.tools)
    const cached = same === 0 ? 0 : tokens(body.messages.slice(0, same)) + tokens(body.tools)
    recorded.push({ kind, body, prompt, cached, same, previous: previous.length })
    const action = kind === "summary" ? { text: summary() } : kind === "agent" ? nextAction() : { text: "Smoke test" }
    const id = `chatcmpl-${recorded.length}`
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "m" }
    const delta = action.tool
      ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${recorded.length}`, type: "function", function: { name: action.tool.name, arguments: JSON.stringify(action.tool.input) } }] }
      : { role: "assistant", content: action.text }
    const usage = { prompt_tokens: prompt, completion_tokens: 30, total_tokens: prompt + 30, prompt_tokens_details: { cached_tokens: Math.min(cached, prompt) } }
    return sse([
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: action.tool ? "tool_calls" : "stop" }] },
      { ...base, choices: [], usage },
    ])
  },
})

// OpenCode, in throwaway folders, with lodestar from this checkout.
const port = 41_000 + Math.floor(Math.random() * 2_000)
const url = `http://127.0.0.1:${port}`
const trace = path.join(root, "trace.jsonl")
const config = {
  providers: {
    mock: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "smoke" },
      models: { m: { name: "Scripted model", limit: { context: WINDOW, output: 4_000 }, capabilities: { tools: true } } },
    },
  },
  model: "mock/m",
  compaction: { buffer: WINDOW - COMPACT_AT },
  plugins: [REPO],
  share: "disabled",
  lsp: false,
}
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("XDG_") && key !== "BUN_BE_BUN")),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_PASSWORD: crypto.randomUUID(),
  LODESTAR_TRACE: trace,
  // Nothing leaves the machine: a request to anything but the local server goes to a closed port.
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  PWD: project,
}
async function opencode(args: string[], timeoutMs = 60_000) {
  const proc = Bun.spawn([OPENCODE, ...args], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { stdout, stderr, code }
}

const serve = Bun.spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
const serverErr = new Response(serve.stderr).text()
let failed = false
const results: string[] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`)
  if (!ok) failed = true
}
try {
  const version = (await opencode(["--version"])).stdout.trim()
  console.log(`${version}, lodestar from ${REPO}`)
  let ready = false
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    const listed = await opencode(["api", "command.list", "--server", url, "--param", `location.directory=${project}`], 10_000)
    ready = listed.code === 0 && listed.stdout.includes('"name":"lodestar"')
    if (!ready) await Bun.sleep(1_000)
  }
  check("lodestar loads and registers /lodestar", ready)
  if (!ready) throw new Error("OpenCode did not start with lodestar")

  const turn = await opencode(["run", "--server", url, "-m", "mock/m", "--auto", "--format", "json", TASK], 300_000)
  const sessionID = turn.stdout.match(/"sessionID":"(ses_[\w]+)"/)?.[1]
  check("the turn ran to the end", turn.code === 0 && step > STEPS, `exit ${turn.code}, ${step} model steps`)
  if (!sessionID) throw new Error(`no session: ${turn.stderr.slice(-500)}`)
  const exported = JSON.parse((await opencode(["session", "export", "--server", url, sessionID])).stdout) as { messages: { type: string; status?: string }[] }
  const compactions = exported.messages.filter((message) => message.type === "compaction" && message.status === "completed").length
  check("OpenCode compacted at least twice", compactions >= 2, `${compactions} compactions`)

  // Every request after a compaction carries one restoration right after the checkpoint, the same until the next one.
  const agent = recorded.filter((request) => request.kind === "agent")
  const checkpointAt = (body: Body) => body.messages.findLastIndex((message) => message.role === "user" && text(message).startsWith("<conversation-checkpoint>"))
  const restorationOf = (body: Body) => {
    const at = checkpointAt(body)
    const next = at < 0 ? undefined : body.messages[at + 1]
    return next && text(next).includes("<restored-context>") ? text(next) : undefined
  }
  const after = agent.filter((request) => checkpointAt(request.body) >= 0)
  const missing = after.filter((request) => !restorationOf(request.body)).length
  check("every request after a compaction has the restoration right after the checkpoint", after.length > 0 && missing === 0, `${after.length - missing} of ${after.length}`)
  const byCheckpoint = new Map<string, Set<string>>()
  for (const request of after) {
    const key = text(request.body.messages[checkpointAt(request.body)])
    byCheckpoint.set(key, (byCheckpoint.get(key) ?? new Set()).add(restorationOf(request.body) ?? ""))
  }
  check("the restoration stays the same until the next compaction", [...byCheckpoint.values()].every((set) => set.size === 1), `${byCheckpoint.size} checkpoints`)
  const restorations = [...byCheckpoint.values()].map((set) => [...set][0] ?? "")
  const count = (test: (restoration: string) => boolean) => `${restorations.filter(test).length} of ${restorations.length}`
  check("every restoration holds the request word for word", restorations.every((restoration) => restoration.includes(TASK)), count((restoration) => restoration.includes(TASK)))
  check("restorations bring back the files the agent changed", restorations.some((restoration) => /## Files you changed[\s\S]*src\/file\d\.ts/.test(restoration)), count((restoration) => restoration.includes("## Files you changed")))
  check("restorations bring back code the agent read", restorations.some((restoration) => restoration.includes("## Code you were reading")), count((restoration) => restoration.includes("## Code you were reading")))

  // Each compaction request repeats the request before it, so the provider's cache covers it.
  const summaries = recorded.map((request, index) => ({ request, index })).filter(({ request }) => request.kind === "summary")
  for (const [number, { request, index }] of summaries.entries()) {
    const before = recorded.slice(0, index).findLast((earlier) => earlier.kind === "agent")
    if (!before) continue
    // It may leave out a reminder lodestar put at the end of the request before, which never enters the session.
    const kept = request.same >= request.previous - 1 && recorded[index - 1] === before
    check(`compaction ${number + 1} repeats the request before it`, kept, `${request.same} of its ${request.previous} messages, ${Math.round((request.cached / request.prompt) * 100)}% cached`)
    check(`compaction ${number + 1} is sent as messages, not flattened to text`, request.body.messages.some((message) => message.role === "tool"))
    check(
      `compaction ${number + 1} carries a restoration only if the request before it did`,
      !!restorationOf(request.body) === !!restorationOf(before.body),
    )
  }

  // lodestar sizes each compaction from the provider's count, and its budget from the room the compaction freed.
  const snapshots = (await readFile(trace, "utf8")).split("\n").filter((line) => line.includes('"snapshot"')).map((line) => JSON.parse(line))
  const counts = new Set(agent.map((request) => request.prompt))
  const measured = snapshots.filter((snapshot) => counts.has(snapshot.compactedMeasured)).length
  check("each restoration's size starts from the provider's count", snapshots.length > 0 && measured === snapshots.length, `${measured} of ${snapshots.length}`)
  const budgets = snapshots.filter((snapshot) => {
    const room = Math.max(0, snapshot.compactedTokens - snapshot.base)
    const expected = Math.floor(Math.min(40_000, 0.2 * WINDOW, Math.max(3_000, 0.2 * room)))
    return snapshot.room === room && snapshot.budget === expected && snapshot.tokens <= snapshot.budget
  }).length
  check("each budget is a fifth of the room the compaction freed, and the restoration stays within it", budgets === snapshots.length, `${budgets} of ${snapshots.length}`)
  const others = recorded.filter((request) => request.kind === "other").length
  results.push(`  (${agent.length} agent requests, ${summaries.length} compaction requests, ${others} other)`)
  for (const snapshot of snapshots)
    results.push(`  (restoration: ${snapshot.tokens} of ${snapshot.budget} tokens from a room of ${snapshot.room}${snapshot.lean ? ", lean" : ""}; ${Object.keys(snapshot.sections ?? {}).join(", ")})`)
} catch (error) {
  failed = true
  results.push(`  FAIL  ${error instanceof Error ? error.message : String(error)}`)
} finally {
  serve.kill("SIGTERM")
  await serve.exited
  server.stop(true)
}
const errors = (await serverErr).split("\n").filter((line) => /plugin failed|lodestar.*error|error.*lodestar/i.test(line))
if (errors.length > 0) results.push(...errors.slice(0, 5).map((line) => `  FAIL  server: ${line.slice(0, 200)}`))
console.log(results.join("\n"))
if (failed || errors.length > 0) {
  console.log(`Failed. The run is kept in ${root}`)
  process.exit(1)
}
console.log("All checks passed.")
if (values.keep) console.log(`The run is kept in ${root}`)
else await rm(root, { recursive: true, force: true })
