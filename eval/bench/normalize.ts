// Reduces a run to the same few numbers for every harness: tokens from the proxy's meter, and tool use from the
// harness's own transcript read with one set of rules.
import path from "node:path"
import type { Metered } from "./box"
import { FILE_READERS, type Trace } from "./types"

/** Luna's list prices in dollars per million tokens. Through a ChatGPT login nothing is billed per token, so this is for comparing. */
export const PRICES = { input: 0.1, cached: 0.01, output: 0.5 }

export interface MeterSummary {
  /** Model responses that reported their use. */
  requests: number
  /** Prompt tokens, cached ones included. */
  input: number
  cached: number
  uncached: number
  output: number
  reasoning: number
  cost: number
  /** The first request's prompt: the harness's own prompt and tools plus the task. */
  firstInput: number
  peakInput: number
  /** The prompt of each request, in order. */
  prompts: number[]
  models: string[]
  efforts: string[]
  tiers: string[]
  /** Requests whose result never arrived or reported no use. */
  unmetered: number
  /** Hosts the proxy refused. */
  denied: string[]
}

export function summarizeMeter(entries: Metered[]): MeterSummary {
  const sorted = [...entries].sort((a, b) => a.t - b.t)
  const responses = sorted.filter((entry) => entry.event === "response" && entry.usage?.input != null)
  const sum = { input: 0, cached: 0, output: 0, reasoning: 0 }
  const prompts: number[] = []
  for (const entry of responses) {
    const usage = entry.usage!
    sum.input += usage.input ?? 0
    sum.cached += usage.cached ?? 0
    sum.output += usage.output ?? 0
    sum.reasoning += usage.reasoning ?? 0
    // OpenCode asks the model for a session title at effort none. That request counts in the totals, but it is not the agent's prompt.
    if (entry.effort !== "none") prompts.push(usage.input ?? 0)
  }
  const modelRequests = sorted.filter((entry) => entry.event === "request" || (entry.event === "response" && entry.path?.includes("responses")))
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))].sort()
  const uncached = sum.input - sum.cached
  return {
    requests: responses.length,
    input: sum.input,
    cached: sum.cached,
    uncached,
    output: sum.output,
    reasoning: sum.reasoning,
    cost: (uncached * PRICES.input + sum.cached * PRICES.cached + sum.output * PRICES.output) / 1e6,
    firstInput: prompts[0] ?? 0,
    peakInput: Math.max(0, ...prompts),
    prompts,
    models: unique(sorted.map((entry) => entry.model)),
    efforts: unique(sorted.map((entry) => entry.effort)),
    tiers: unique(sorted.map((entry) => entry.tier)),
    unmetered: Math.max(0, modelRequests.filter((entry) => entry.event === "request").length - responses.filter((entry) => entry.kind === "ws").length),
    denied: unique(sorted.filter((entry) => entry.event === "denied").map((entry) => entry.host)),
  }
}

/** The files a shell command prints, when it is one of the usual ways to read them. Approximate, and the same for every harness. */
export function filesRead(command: string): string[] {
  if (!FILE_READERS.test(command)) return []
  const files: string[] = []
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().split(/\s+/)
    const index = words.findIndex((word) => /^(cat|head|tail|nl|less|more|bat|sed|awk)$/.test(word))
    if (index < 0) continue
    for (const word of words.slice(index + 1)) {
      const clean = word.replace(/^['"]|['"]$/g, "")
      if (!clean || clean.startsWith("-") || /^[\d,$]+[pd]?$/.test(clean) || /^\d+(,\d+)?p$/.test(clean)) continue
      if (/[{}$]/.test(clean) && !clean.includes("/")) continue
      if (clean.includes("/") || /\.\w{1,5}$/.test(clean)) files.push(clean)
    }
  }
  return files
}

export interface TraceSummary {
  toolCalls: number
  failedCalls: number
  reads: number
  /** Reads of a file the agent had already read. */
  rereads: number
  /** Reads, after each compaction, of a file read before it: the first read of each such file. */
  rereadsAfterCompaction: number
  edits: number
  shell: number
  searches: number
  compactions: number
}

export function summarizeTrace(trace: Trace, cwd: string): TraceSummary {
  const normalize = (file: string) => path.resolve(cwd, file)
  const seen = new Set<string>()
  let before = new Set<string>()
  let afterCompaction = new Set<string>()
  const summary: TraceSummary = { toolCalls: 0, failedCalls: 0, reads: 0, rereads: 0, rereadsAfterCompaction: 0, edits: 0, shell: 0, searches: 0, compactions: 0 }
  for (const tool of trace) {
    if (tool.type === "compaction") {
      summary.compactions++
      before = new Set(seen)
      afterCompaction = new Set()
      continue
    }
    summary.toolCalls++
    if (!tool.ok) summary.failedCalls++
    const reads = tool.kind === "read" && tool.file ? [tool.file] : tool.kind === "shell" && tool.command ? filesRead(tool.command) : []
    if (tool.kind === "edit") summary.edits++
    if (tool.kind === "shell") summary.shell++
    if (tool.kind === "search") summary.searches++
    for (const file of reads) {
      const key = normalize(file)
      summary.reads++
      if (seen.has(key)) summary.rereads++
      if (before.has(key) && !afterCompaction.has(key)) {
        summary.rereadsAfterCompaction++
        afterCompaction.add(key)
      }
      seen.add(key)
    }
  }
  return summary
}
