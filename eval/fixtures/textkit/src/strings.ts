/** Upper-cases the first letter of every word. */
export function capitalizeWords(text: string): string {
  return text.replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
}

/** Reverses the order of the words. */
export function reverseWords(text: string): string {
  return text.split(/\W+/).filter(Boolean).reverse().join(" ")
}

/** Centers text in a field of the given width. Extra fill goes on the right. */
export function padCenter(text: string, width: number, fill = " "): string {
  if (fill.length !== 1) throw new Error("fill must be one character")
  const total = Math.max(0, width - text.length)
  const left = Math.floor(total / 2)
  return fill.repeat(left) + text + fill.repeat(total - left)
}

export function countVowels(text: string): number {
  return (text.match(/[aeiou]/gi) ?? []).length
}
