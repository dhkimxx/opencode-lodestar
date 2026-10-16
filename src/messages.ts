import type { Message } from "@opencode/ai"

const CHECKPOINT = "<conversation-checkpoint>"

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

/** Inserts a reminder at the end of the request, before the user's newest message when that comes last. */
export function insertNearEnd(messages: Message[], message: Message) {
  const at = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length
  messages.splice(at, 0, message)
}
