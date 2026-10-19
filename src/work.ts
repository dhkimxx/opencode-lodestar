import path from "node:path"
import { contentText, readRange, SHELL_TOOLS, touchedFiles } from "./files"
import { CALLS_KEPT, REQUEST_CHARS, RESTORE_REQUESTS, TEST_TAIL_CHARS, TEST_TAIL_LINES } from "./limits"
import type { SessionState } from "./state"

/** Shell commands that run tests. */
const TEST_COMMAND =
  /(^|[\s;&|(/])(pytest|py\.test|tox|nox|jest|vitest|mocha|phpunit|rspec|ctest)\b|\b(go|cargo|dotnet|mix|swift|deno|bun) test\b|\b(npm|pnpm|yarn)( run)? test|\bmake (test|check)\b|\bunittest\b|\b(mvn|gradlew?)\b.*\btest\b/

export const isTestCommand = (command: string) => TEST_COMMAND.test(command)

/** One line, cut to `chars` characters. */
function oneLine(text: string, chars: number) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > chars ? `${line.slice(0, chars)}…` : line
}

function tail(text: string) {
  const lines = text.replace(/\s+$/, "").split("\n").slice(-TEST_TAIL_LINES).join("\n")
  return lines.length > TEST_TAIL_CHARS ? `…${lines.slice(-TEST_TAIL_CHARS)}` : lines
}

/** A short description of a tool call, such as "read src/a.ts, lines 40-120" or "shell `go test ./...`". */
export function describeCall(tool: string, input: unknown, output: unknown, content: unknown, directory: string): string {
  const fields = (input ?? {}) as Record<string, unknown>
  const relative = (file: string) => path.relative(directory, path.resolve(directory, file)) || file
  if (typeof fields.command === "string") return `${tool} \`${oneLine(fields.command, 200)}\``
  if (typeof fields.pattern === "string") {
    const where = typeof fields.path === "string" ? ` in ${relative(fields.path)}` : ""
    return `${tool} \`${oneLine(fields.pattern, 120)}\`${where}`
  }
  const touched = touchedFiles(tool, input, output, directory)
  const files = [...touched.read, ...touched.edited]
  if (files.length > 0) {
    const range = tool === "read" ? readRange(content) : undefined
    return `${tool} ${files.map(relative).join(", ")}${range ? `, lines ${range[0]}-${range[1]}` : ""}`
  }
  const file = fields.path ?? fields.filePath
  if (typeof file === "string") return `${tool} ${relative(file)}`
  const first = Object.values(fields).find((value) => typeof value === "string")
  return typeof first === "string" ? `${tool} ${oneLine(first, 120)}` : tool
}

/** Notes a finished tool call for the restoration: what it did, how it ended, and the output of a test run. */
export function recordCall(
  state: SessionState,
  call: { tool: string; input: unknown; output?: unknown; content?: unknown; error?: string; directory: string },
) {
  const fields = (call.output ?? {}) as { exit?: unknown }
  const exit = typeof fields.exit === "number" ? fields.exit : undefined
  const outcome = call.error !== undefined ? `failed: ${oneLine(call.error, 200)}` : exit !== undefined ? `exit ${exit}` : undefined
  const what = describeCall(call.tool, call.input, call.output, call.content, call.directory)
  state.calls = [...(state.calls ?? []), { what, ...(outcome ? { outcome } : {}) }].slice(-CALLS_KEPT)

  const command = (call.input as { command?: unknown } | undefined)?.command
  if (SHELL_TOOLS.has(call.tool) && typeof command === "string" && isTestCommand(command)) {
    const output = call.error ?? (contentText(call.content) || String((call.output as { output?: unknown } | undefined)?.output ?? ""))
    state.lastTest = { command: oneLine(command, 300), ...(exit !== undefined ? { exit } : {}), tail: tail(output) }
  }
}

/** Keeps a request from the user: the first one stays, and the latest few after it. */
export function recordRequest(state: SessionState, text: string) {
  const request = text.trim().slice(0, REQUEST_CHARS)
  if (!request) return
  const requests = state.requests ?? []
  if (requests.includes(request)) return
  const [first, ...later] = [...requests, request]
  state.requests = [first, ...later.slice(-RESTORE_REQUESTS)]
}
