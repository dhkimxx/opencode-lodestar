import type { Operator, Token } from "./tokenizer"

export type Node =
  | { type: "number"; value: number }
  | { type: "variable"; name: string }
  | { type: "negate"; operand: Node }
  | { type: "binary"; op: Operator; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] }

const PRECEDENCE: Record<Operator, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 }

export function parse(tokens: Token[]): Node {
  let position = 0
  const peek = () => tokens[position]
  const next = () => {
    const token = tokens[position++]
    if (!token) throw new SyntaxError("Unexpected end of input")
    return token
  }
  const expectParen = (value: "(" | ")") => {
    const token = next()
    if (token.kind !== "paren" || token.value !== value) throw new SyntaxError(`Expected '${value}' at ${token.at}`)
  }

  // Precedence climbing: binds operators whose precedence is at least `min`.
  function expression(min: number): Node {
    let left = unary()
    for (;;) {
      const token = peek()
      if (!token || token.kind !== "operator" || PRECEDENCE[token.op] < min) return left
      next()
      const right = expression(PRECEDENCE[token.op] + 1)
      left = { type: "binary", op: token.op, left, right }
    }
  }

  function unary(): Node {
    const token = peek()
    if (token?.kind === "operator" && token.op === "-") {
      next()
      return { type: "negate", operand: unary() }
    }
    return primary()
  }

  function primary(): Node {
    const token = next()
    if (token.kind === "number") return { type: "number", value: token.value }
    if (token.kind === "paren" && token.value === "(") {
      const inner = expression(1)
      expectParen(")")
      return inner
    }
    if (token.kind === "identifier") {
      const after = peek()
      if (after?.kind !== "paren" || after.value !== "(") return { type: "variable", name: token.name }
      next()
      const args: Node[] = []
      if (peek()?.kind !== "paren") {
        args.push(expression(1))
        while (peek()?.kind === "comma") {
          next()
          args.push(expression(1))
        }
      }
      expectParen(")")
      return { type: "call", name: token.name, args }
    }
    throw new SyntaxError(`Unexpected token at ${token.at}`)
  }

  const tree = expression(1)
  const extra = peek()
  if (extra) throw new SyntaxError(`Unexpected token at ${extra.at}`)
  return tree
}
