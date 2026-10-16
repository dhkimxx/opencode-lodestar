import { evaluate } from "./evaluator"
import { parse } from "./parser"
import { tokenize } from "./tokenizer"

/** Evaluates an arithmetic expression such as `2 * (x + 1) ^ 2`. */
export function calc(source: string, variables: Record<string, number> = {}): number {
  return evaluate(parse(tokenize(source)), variables)
}
