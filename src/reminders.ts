import path from "node:path"
import { diskState, lastUsed } from "./files"
import { RECITE_AFTER_TOOL_CALLS, STALE_CHECK_FILES } from "./limits"
import type { SessionState, TodoItem } from "./state"

function todoLine(items: readonly TodoItem[]) {
  if (items.length === 0) return ""
  const count = (status: TodoItem["status"]) => items.filter((item) => item.status === status).length
  const current = items.find((item) => item.status === "in_progress")
  return ` Your todo list has ${count("done")} done, ${count("in_progress")} in progress${current ? ` ("${current.text}")` : ""}, and ${count("pending")} pending.`
}

/** T4: asks for a short recap after a long run of tool calls, once per run. */
export function recitation(state: SessionState): string | undefined {
  if (state.toolStreak < RECITE_AFTER_TOOL_CALLS || state.recited) return undefined
  return `<lodestar-reminder>You have made ${state.toolStreak} tool calls since you last wrote to the user. Before your next tool call, write one or two sentences: what is done so far, and what you will do next.${todoLine(state.todo)}</lodestar-reminder>`
}

/** T6: files that changed on disk after the agent last read or edited them, each reported once. */
export async function staleFiles(state: SessionState) {
  const records = Object.values(state.files)
    .filter((record) => record.seen)
    .sort((a, b) => lastUsed(b) - lastUsed(a))
    .slice(0, STALE_CHECK_FILES)
  const changed: string[] = []
  const deleted: string[] = []
  for (const record of records) {
    const seen = record.seen
    if (!seen) continue
    const now = await diskState(record.path)
    if (!now) {
      if (record.reported !== "deleted") {
        deleted.push(record.path)
        record.reported = "deleted"
      }
      continue
    }
    if (now.mtimeMs === seen.mtimeMs && now.size === seen.size) continue
    const reported = record.reported
    if (reported && reported !== "deleted" && reported.mtimeMs === now.mtimeMs && reported.size === now.size) continue
    changed.push(record.path)
    record.reported = now
  }
  return { changed, deleted }
}

export function staleNotice(state: SessionState, files: { changed: string[]; deleted: string[] }): string | undefined {
  if (files.changed.length === 0 && files.deleted.length === 0) return undefined
  const relative = (file: string) => (state.directory ? path.relative(state.directory, file) || file : file)
  const lines = [
    ...(files.changed.length > 0
      ? [`These files changed on disk after you last read or edited them: ${files.changed.map(relative).join(", ")}. Read them again before you edit them.`]
      : []),
    ...(files.deleted.length > 0 ? [`These files were deleted: ${files.deleted.map(relative).join(", ")}.`] : []),
  ]
  return `<lodestar-reminder>${lines.join(" ")}</lodestar-reminder>`
}
