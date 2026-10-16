import type { Message } from "@opencode/ai"
import { SUMMARY_INPUT_SHARE, SUMMARY_MAX_INPUT_TOKENS, SUMMARY_TIMEOUT_MS } from "./limits"
import { isCheckpoint, parts, textOf } from "./messages"
import { formatTodo } from "./restore"
import type { TodoItem } from "./state"
import { estimateTokens } from "./tokens"

const SECTIONS = [
  "## User requests",
  "Every request the user made, in order, each marked done, in progress, or not started. Quote the user's own words for any request that isn't done.",
  "## Rules from the user",
  "Every rule, constraint, and preference the user stated, word for word: what to do, what never to do, and which files or areas are off limits. Keep all of them, even ones that seem minor or were stated long ago.",
  "## Key facts",
  "Facts the work depends on: how the code is organized, the conventions it follows, and decisions made, with their reasons.",
  "## Files",
  "Each file read or changed, with what matters about it. Include short code excerpts wherever later work has to match exact names, signatures, or values.",
  "## Errors and fixes",
  "Each error, quoted exactly, and what fixed it. Also what was tried and didn't work, so it isn't tried again.",
  "## Plan and progress",
  "The plan or todo list, with the status of every item.",
  "## Current work",
  "What was being done right before this checkpoint, in detail.",
  "## Next step",
  "The next step, as it follows from the user's latest request. Don't invent new work.",
]

const HEADINGS = SECTIONS.filter((line) => line.startsWith("## "))

const clip = (text: string, chars: number) =>
  text.length <= chars ? text : `${text.slice(0, chars)}\n[… ${text.length - chars} more characters]`

function resultText(part: { readonly [key: string]: unknown }): string {
  const result = part.result as { type?: string; value?: unknown } | undefined
  if (!result) return ""
  if (result.type === "text" && typeof result.value === "string") return result.value
  if (result.type === "error") return `Error: ${typeof result.value === "string" ? result.value : JSON.stringify(result.value)}`
  if (result.type === "content" && Array.isArray(result.value)) {
    return result.value
      .map((item: { type?: string; text?: string }) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
      .join("\n")
  }
  return JSON.stringify(result.value) ?? ""
}

interface Entry {
  text: string
  /** Tool output can shrink further when the transcript is too long. */
  output?: string
  label?: string
}

/**
 * The older conversation as plain text. Recent tool output is kept longer than old tool output, and the oldest
 * entries go first when it still doesn't fit. The first user message always stays: it usually holds the task.
 */
export function transcript(messages: readonly Message[], maxTokens: number) {
  let previous: string | undefined
  const entries: Entry[] = []
  for (const message of messages) {
    if (isCheckpoint(message)) {
      previous = textOf(message)
      continue
    }
    for (const part of parts(message)) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        const limit = message.role === "user" ? (entries.length === 0 ? 20_000 : 12_000) : 4_000
        entries.push({ text: `[${message.role}]\n${clip(part.text, limit)}` })
      } else if (part.type === "tool-call") {
        entries.push({ text: `[tool call: ${String(part.name)}] ${clip(JSON.stringify(part.input) ?? "", 1_500)}` })
      } else if (part.type === "tool-result") {
        entries.push({ text: "", label: `[tool result: ${String(part.name)}]`, output: resultText(part) })
      }
    }
  }
  const results = entries.filter((entry) => entry.output !== undefined)
  results.forEach((entry, index) => {
    const limit = index >= results.length - 30 ? 4_000 : 600
    entry.text = `${entry.label}\n${clip(entry.output ?? "", limit)}`
  })
  const limit = maxTokens * 4
  const size = () => entries.reduce((sum, entry) => sum + entry.text.length + 2, 0)
  if (size() > limit) for (const entry of results) entry.text = `${entry.label}\n${clip(entry.output ?? "", 200)}`
  while (size() > limit && entries.length > 2) entries.splice(1, 1)
  return { previous, text: entries.map((entry) => entry.text).join("\n\n") }
}

export function summaryPrompt(input: { previous?: string; todo: readonly TodoItem[]; conversation: string }) {
  return [
    "You are writing the checkpoint for a coding session. The conversation below will be removed, and the agent will continue from this checkpoint, the most recent messages, and fresh copies of the files it was working with. Anything you leave out is lost.",
    "",
    "Write Markdown with exactly these sections, in this order:",
    "",
    SECTIONS.join("\n"),
    "",
    "Write facts, not commentary. Stay under 2,000 words. Don't call tools. Reply with the checkpoint only.",
    ...(input.previous
      ? ["", "Carry everything that still matters from the previous checkpoint into the new one.", "<previous-checkpoint>", input.previous, "</previous-checkpoint>"]
      : []),
    ...(input.todo.length > 0 ? ["", "<todo-list>", formatTodo(input.todo), "</todo-list>"] : []),
    "",
    "<conversation>",
    input.conversation,
    "</conversation>",
  ].join("\n")
}

/** A reply counts as a checkpoint when it has most of the sections. */
export const looksLikeCheckpoint = (text: string) => HEADINGS.filter((heading) => text.includes(heading)).length >= 5

export function summaryInputTokens(window: number) {
  return Math.floor(Math.min(SUMMARY_MAX_INPUT_TOKENS, SUMMARY_INPUT_SHARE * window))
}

/** Resolves to undefined after the timeout, so the caller can fall back to OpenCode's own summary. */
export async function withTimeout<T>(promise: Promise<T>, ms = SUMMARY_TIMEOUT_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const estimateUsage = (prompt: string, reply: string) => ({
  input: estimateTokens(prompt),
  output: estimateTokens(reply),
  reasoning: 0,
  cache: { read: 0, write: 0 },
})
