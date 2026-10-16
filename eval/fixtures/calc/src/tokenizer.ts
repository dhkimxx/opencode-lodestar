export type Operator = "+" | "-" | "*" | "/" | "^"

export type Token =
  | { kind: "number"; value: number; at: number }
  | { kind: "identifier"; name: string; at: number }
  | { kind: "operator"; op: Operator; at: number }
  | { kind: "paren"; value: "(" | ")"; at: number }
  | { kind: "comma"; at: number }

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source.charAt(index)
    if (/\s/.test(char)) {
      index++
      continue
    }
    const number = source.slice(index).match(/^\d+/)
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]), at: index })
      index += number[0].length
      continue
    }
    const identifier = source.slice(index).match(/^[a-z_][a-z0-9_]*/i)
    if (identifier) {
      tokens.push({ kind: "identifier", name: identifier[0], at: index })
      index += identifier[0].length
      continue
    }
    if ("+-*/^".includes(char)) tokens.push({ kind: "operator", op: char as Operator, at: index })
    else if (char === "(" || char === ")") tokens.push({ kind: "paren", value: char, at: index })
    else if (char === ",") tokens.push({ kind: "comma", at: index })
    else throw new SyntaxError(`Unexpected character '${char}' at ${index}`)
    index++
  }
  return tokens
}
