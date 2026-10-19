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
