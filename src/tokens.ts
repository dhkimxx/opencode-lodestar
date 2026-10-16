/** A rough token count: about four characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** Keeps the start of the text, within about `tokens` tokens. */
export function keepStart(text: string, tokens: number): string {
  const limit = tokens * 4
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[… cut to about ${tokens} tokens]`
}
