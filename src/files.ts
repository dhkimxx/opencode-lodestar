import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { RANGES_KEPT, SHELL_RUNS_KEPT } from "./limits"
import type { DiskState, FileRecord, SessionState } from "./state"

const EDIT_TOOLS = new Set(["edit", "write", "multiedit"])
export const SHELL_TOOLS = new Set(["shell", "bash"])
/** Records kept per session. Older ones are dropped first. */
const MAX_RECORDS = 200

export async function diskState(file: string): Promise<DiskState | undefined> {
  try {
    const info = await stat(file)
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined
  } catch {
    return undefined
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return undefined
  }
}

export const lastUsed = (record: FileRecord) => Math.max(record.readAt ?? 0, record.editedAt ?? 0)

/** The text of a tool result's content, which is a string or a list of parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
}

/** The lines a read returned, from the header OpenCode's read tool puts on its output: "Read file a.ts, lines 40-120". */
export function readRange(content: unknown): [number, number] | undefined {
  const match = contentText(content).match(/^Read file .*, lines (\d+)-(\d+)/m)
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  return start >= 1 && end >= start ? [start, end] : undefined
}

/** Adds a range to a file's ranges. One that overlaps or touches others merges with them and counts as the newest. */
export function addRange(ranges: [number, number][] | undefined, range: [number, number]): [number, number][] {
  let [start, end] = range
  const rest: [number, number][] = []
  for (const [from, to] of ranges ?? []) {
    if (from <= end + 1 && to >= start - 1) {
      start = Math.min(start, from)
      end = Math.max(end, to)
    } else rest.push([from, to])
  }
  return [...rest, [start, end] as [number, number]].slice(-RANGES_KEPT)
}

/** Files a finished tool call read or changed, as absolute paths. */
export function touchedFiles(tool: string, input: unknown, output: unknown, directory: string) {
  const resolve = (value: unknown) => (typeof value === "string" && value ? path.resolve(directory, value) : undefined)
  const fields = (input ?? {}) as Record<string, unknown>
  const file = resolve(fields.path ?? fields.filePath)
  if (tool === "read" && file) return { read: [file], edited: [] }
  if (EDIT_TOOLS.has(tool) && file) return { read: [], edited: [file] }
  if (tool === "patch") {
    const applied = ((output ?? {}) as { applied?: { target?: unknown; type?: unknown }[] }).applied ?? []
    const edited = applied.flatMap((item) => {
      const target = item.type === "delete" ? undefined : resolve(item.target)
      return target ? [target] : []
    })
    return { read: [], edited }
  }
  return { read: [], edited: [] }
}

/** Notes when one of the agent's shell commands ran. */
export function recordShellRun(state: SessionState, start: number, end: number) {
  state.shellRuns = [...(state.shellRuns ?? []), { start, end }].slice(-SHELL_RUNS_KEPT)
}

/** Notes what a tool call read or changed, and how the file looked on disk right after. */
export async function recordTool(
  state: SessionState,
  input: { tool: string; input: unknown; output: unknown; content?: unknown; directory: string; now: number },
) {
  const touched = touchedFiles(input.tool, input.input, input.output, input.directory)
  for (const [files, field] of [
    [touched.read, "readAt"],
    [touched.edited, "editedAt"],
  ] as const) {
    for (const file of files) {
      const record = (state.files[file] ??= { path: file })
      record[field] = input.now
      record.seen = await diskState(file)
      record.reported = undefined
      const range = field === "readAt" ? readRange(input.content) : undefined
      if (range) record.ranges = addRange(record.ranges, range)
    }
  }
  const records = Object.values(state.files)
  if (records.length > MAX_RECORDS) {
    for (const record of records.sort((a, b) => lastUsed(a) - lastUsed(b)).slice(0, records.length - MAX_RECORDS)) {
      delete state.files[record.path]
    }
  }
  return touched.read.length + touched.edited.length > 0
}
