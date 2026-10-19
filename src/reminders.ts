import path from "node:path"
import { diskState, lastUsed } from "./files"
import { RECITE_AFTER_TOOL_CALLS, SHELL_RUN_SLACK_MS, STALE_CHECK_FILES } from "./limits"
import type { SessionState } from "./state"

/** T4: asks for a short recap after a long run of tool calls, once per run. */
export function recitation(state: SessionState): string | undefined {
  if (state.toolStreak < RECITE_AFTER_TOOL_CALLS || state.recited) return undefined
  return `<lodestar-reminder>You have made ${state.toolStreak} tool calls since you last wrote to the user. Before your next tool call, write one or two sentences: what is done so far, and what you will do next. Then carry on in the same response.</lodestar-reminder>`
}

/** True when a time falls within one of the agent's own shell commands, give or take a little. */
const duringShell = (state: SessionState, time: number) =>
  (state.shellRuns ?? []).some((run) => time >= run.start - SHELL_RUN_SLACK_MS && time <= run.end + SHELL_RUN_SLACK_MS)

/**
 * T6: files that changed on disk after the agent last read or edited them, each reported once. A change made while one
 * of the agent's own shell commands ran, such as a formatter or a test run, is the agent's doing and isn't reported.
 * In evaluation, those made up 88% of the notices, and the notices that followed led to needless re-reads.
 */
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
        // A deleted file has no change time, so any shell command since the agent last saw it counts.
        if (!(state.shellRuns ?? []).some((run) => run.end >= lastUsed(record))) deleted.push(record.path)
        record.reported = "deleted"
      }
      continue
    }
    if (now.mtimeMs === seen.mtimeMs && now.size === seen.size) continue
    if (duringShell(state, now.mtimeMs)) {
      record.seen = now
      continue
    }
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
