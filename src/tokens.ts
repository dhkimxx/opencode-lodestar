/** A rough token count: about four characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** Keeps the start of the text, within about `tokens` tokens. */
export function keepStart(text: string, tokens: number): string {
  const limit = tokens * 4
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[… cut to about ${tokens} tokens]`
}

/** Keeps the start and the end of the text, within about `tokens` tokens. */
export function keepEnds(text: string, tokens: number): string {
  const limit = tokens * 4
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n[… about ${estimateTokens(text.slice(half, -half))} tokens left out …]\n${text.slice(-half)}`
}

/**
 * The prompt a step sent, as the provider counted it: new input plus what was read from or written to its cache. Taken
 * from the `tokens` of OpenCode's `session.step.ended` event.
 */
export function promptTokens(tokens: unknown): number | undefined {
  const usage = tokens as { input?: unknown; cache?: { read?: unknown; write?: unknown } } | undefined
  if (typeof usage?.input !== "number") return undefined
  const read = typeof usage.cache?.read === "number" ? usage.cache.read : 0
  const write = typeof usage.cache?.write === "number" ? usage.cache.write : 0
  return usage.input + read + write
}
