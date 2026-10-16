import path from "node:path"
import { isAssistant, isCompaction, isTool, isUser, type SessionExport, type Tokens, type ToolPart } from "./session"

export interface Metrics {
  turns: number
  steps: number
  toolCalls: number
  toolErrors: number
  reads: number
  /** Reads of a file the session had already read. */
  rereads: number
  /** After each compaction, the first read of each file that was read before it. */
  rereadsAfterCompaction: number
  edits: number
  failedEdits: number
  /** Edits identical to an earlier edit, a sign of repeating an attempt. */
  repeatedEdits: number
  shellCommands: number
  compactions: number
  autoCompactions: number
  failedCompactions: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** Share of prompt tokens served from the provider's cache. */
  cacheHitRate: number
  cost: number
  durationMs: number
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

function filePath(tool: ToolPart): string | undefined {
  const input = tool.state.input ?? {}
  const value = input.path ?? input.filePath
  return typeof value === "string" ? path.resolve(value) : undefined
}

function addTokens(total: Metrics["tokens"], tokens: Tokens | undefined) {
  if (!tokens) return
  total.input += tokens.input
  total.output += tokens.output
  total.reasoning += tokens.reasoning
  total.cacheRead += tokens.cache.read
  total.cacheWrite += tokens.cache.write
}

export function measure(data: SessionExport): Metrics {
  const metrics: Metrics = {
    turns: 0,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    reads: 0,
    rereads: 0,
    rereadsAfterCompaction: 0,
    edits: 0,
    failedEdits: 0,
    repeatedEdits: 0,
    shellCommands: 0,
    compactions: 0,
    autoCompactions: 0,
    failedCompactions: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cacheHitRate: 0,
    cost: 0,
    durationMs: 0,
  }
  const read = new Set<string>()
  let readBeforeCompaction = new Set<string>()
  let rereadSinceCompaction = new Set<string>()
  const editKeys = new Set<string>()
  const messageTokens: Metrics["tokens"] = { ...metrics.tokens }
  let messageCost = 0
  let last = data.info.time.created

  for (const message of data.messages) {
    last = Math.max(last, message.time.created)
    if (isUser(message)) metrics.turns++
    if (isCompaction(message)) {
      metrics.compactions++
      if (message.reason === "auto" || message.reason === "overflow") metrics.autoCompactions++
      if (message.status === "failed") metrics.failedCompactions++
      readBeforeCompaction = new Set(read)
      rereadSinceCompaction = new Set()
      addTokens(messageTokens, message.tokens)
      messageCost += message.cost ?? 0
    }
    if (!isAssistant(message)) continue
    metrics.steps++
    addTokens(messageTokens, message.tokens)
    messageCost += message.cost ?? 0
    last = Math.max(last, message.time.completed ?? 0)
    for (const part of message.content) {
      if (!isTool(part)) continue
      metrics.toolCalls++
      const failed = part.state.status !== "completed"
      if (failed) metrics.toolErrors++
      const file = filePath(part)
      if (part.name === "read" && file) {
        metrics.reads++
        if (read.has(file)) metrics.rereads++
        if (readBeforeCompaction.has(file) && !rereadSinceCompaction.has(file)) {
          metrics.rereadsAfterCompaction++
          rereadSinceCompaction.add(file)
        }
        read.add(file)
      }
      if (EDIT_TOOLS.has(part.name)) {
        metrics.edits++
        if (failed) metrics.failedEdits++
        const key = JSON.stringify([part.name, part.state.input])
        if (editKeys.has(key)) metrics.repeatedEdits++
        editKeys.add(key)
      }
      if (part.name === "shell" || part.name === "bash") metrics.shellCommands++
    }
  }

  // The session totals also count requests outside the transcript, such as the title. Prefer them when present.
  metrics.tokens = data.info.tokens
    ? {
        input: data.info.tokens.input,
        output: data.info.tokens.output,
        reasoning: data.info.tokens.reasoning,
        cacheRead: data.info.tokens.cache.read,
        cacheWrite: data.info.tokens.cache.write,
      }
    : messageTokens
  metrics.cost = data.info.cost ?? messageCost
  const prompt = metrics.tokens.input + metrics.tokens.cacheRead
  metrics.cacheHitRate = prompt > 0 ? metrics.tokens.cacheRead / prompt : 0
  metrics.durationMs = Math.max(0, (data.info.time.idle ?? last) - data.info.time.created)
  return metrics
}

/** Paths under the user's home that a tool call touched outside the project, like another repository. */
export function outsideAccess(data: SessionExport, workdir: string, home: string): string[] {
  const found = new Set<string>()
  for (const message of data.messages) {
    if (!isAssistant(message)) continue
    for (const part of message.content) {
      if (!isTool(part)) continue
      const input = part.state.input ?? {}
      for (const value of [input.path, input.filePath, input.workdir, input.command, input.pattern]) {
        if (typeof value !== "string") continue
        for (const match of value.matchAll(/(?:^|[\s'"=(])(\/[^\s'"`;|&)]+)/g)) {
          const file = match[1] ?? ""
          if (file.startsWith(home) && !file.startsWith(workdir)) found.add(file)
        }
      }
    }
  }
  return [...found]
}
