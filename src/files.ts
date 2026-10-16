import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { DiskState, FileRecord, SessionState } from "./state"

const EDIT_TOOLS = new Set(["edit", "write", "multiedit"])
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

/** Notes what a tool call read or changed, and how the file looked on disk right after. */
export async function recordTool(
  state: SessionState,
  input: { tool: string; input: unknown; output: unknown; directory: string; now: number },
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
