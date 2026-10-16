import { capitalizeWords, padCenter } from "./strings"

/** Formats a person's name for display, like "ada lovelace" -> "Ada Lovelace". */
export function formatName(name: string): string {
  return capitalizeWords(name.trim().replace(/\s+/g, " "))
}

/** A boxed title for terminal output. */
export function banner(title: string, width = 30): string {
  const line = "=".repeat(width)
  return [line, padCenter(capitalizeWords(title), width), line].join("\n")
}
