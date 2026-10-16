import type { Node } from "./parser"

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  max: (...args) => Math.max(...args),
  min: (...args) => Math.min(...args),
  sqrt: (value) => Math.sqrt(value),
  abs: (value) => Math.abs(value),
}

export function evaluate(node: Node, variables: Record<string, number> = {}): number {
  switch (node.type) {
    case "number":
      return node.value
    case "variable":
      return variables[node.name] as number
    case "negate":
      return -evaluate(node.operand, variables)
    case "call": {
      const fn = FUNCTIONS[node.name]
      if (!fn) throw new ReferenceError(`Unknown function: ${node.name}`)
      return fn(...node.args.map((arg) => evaluate(arg, variables)))
    }
    case "binary": {
      const left = evaluate(node.left, variables)
      const right = evaluate(node.right, variables)
      switch (node.op) {
        case "+":
          return left + right
        case "-":
          return left - right
        case "*":
          return left * right
        case "/":
          if (right === 0) throw new RangeError("Division by zero")
          return left / right
        case "^":
          return left ** right
      }
    }
  }
}
