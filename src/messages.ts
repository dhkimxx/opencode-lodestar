import type { Message } from "@opencode/ai/effect"
import { estimateTokens } from "./tokens"

const CHECKPOINT = "<conversation-checkpoint>"

/** A request as OpenCode's `context` and `compaction` hooks pass it. */
export interface RequestShape {
  readonly system?: unknown
  readonly tools?: unknown
  readonly messages: readonly Message[]
}

/** An estimate of the messages' contents. */
export function contentTokens(messages: readonly Message[]): number {
  return estimateTokens(JSON.stringify(messages.map((message) => (message as { content?: unknown }).content)))
}

/** An estimate of the whole request: the system prompt, the tool definitions, and the messages. */
export function requestTokens(request: RequestShape): number {
  return estimateTokens(JSON.stringify(request.system ?? [])) + estimateTokens(JSON.stringify(request.tools ?? {})) + contentTokens(request.messages)
}

/**
 * The request's size the way OpenCode 2.2 sizes it to decide on compaction: the provider's count of the latest
 * response's prompt, plus an estimate of that response and what came after it, which the count doesn't cover. Characters
 * alone miss the system prompt's real size and overstate a conversation whose old reasoning the provider drops. Without
 * a count, the whole request is estimated.
 */
export function promptSize(request: RequestShape, measured: number | undefined): number {
  if (measured === undefined) return requestTokens(request)
  const reply = request.messages.findLastIndex((message) => message.role === "assistant")
  return measured + (reply < 0 ? 0 : contentTokens(request.messages.slice(reply)))
}

type Part = { readonly type: string; readonly [key: string]: unknown }

function parts(message: Message): readonly Part[] {
  const content = (message as { content: unknown }).content
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? (content as Part[]) : []
}

export function textOf(message: Message): string {
  return parts(message)
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
}

/** Index of the message OpenCode builds from the latest compaction summary, or -1. */
export function checkpointIndex(messages: readonly Message[]): number {
  return messages.findLastIndex((message) => message.role === "user" && textOf(message).startsWith(CHECKPOINT))
}

/**
 * Makes a user message with the host's own Message class, taken from a message already in the request.
 * Plugins can't load @opencode/ai themselves, so there is no other way to build one. Returns undefined if the
 * class doesn't look as expected, and the caller then leaves the request alone.
 */
export function userMessage(messages: readonly Message[], text: string): Message | undefined {
  const host = messages[0]?.constructor as { user?: (content: string) => Message } | undefined
  if (typeof host?.user !== "function") return undefined
  return host.user(text)
}

/** The lines `/lodestar` posts to the conversation. They are for the user, and the model doesn't need to read them. */
const NOTICE = /^lodestar (is (on|off)\.|did not understand)/

export function removeNotices(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = textOf(messages[index] as Message)
    if (text.length < 300 && NOTICE.test(text)) messages.splice(index, 1)
  }
}

/** Inserts a reminder at the end of the request, before the user's newest message when that comes last. */
export function insertNearEnd(messages: Message[], message: Message) {
  const at = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length
  messages.splice(at, 0, message)
}
