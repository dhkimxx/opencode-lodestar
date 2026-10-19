import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { changesOf } from "./changes"
import { diskState, lastUsed, readText } from "./files"
import {
  RESTORE_DIFF_CONTEXT,
  RESTORE_DIFF_TOKENS,
  RESTORE_FILE_TOKENS,
  RESTORE_FILES,
  RESTORE_LINE_CHARS,
  RESTORE_MAX_TOKENS,
  RESTORE_MIN_TOKENS,
  RESTORE_OTHER_FILES,
  RESTORE_PLAN_TOKENS,
  RESTORE_READ_FILES,
  RESTORE_READ_TOKENS,
  RESTORE_REQUEST_TOKENS,
  RESTORE_SHARE,
  RESTORE_SKILL_TOKENS,
  RESTORE_SKILLS_TOTAL,
  RESTORE_STATUS_LINES,
  RESTORE_TASK_TOKENS,
} from "./limits"
import type { FileRecord, SessionState, Snapshot } from "./state"
import { estimateTokens, keepEnds, keepStart } from "./tokens"

/** Where OpenCode's plan mode writes plans. */
export const PLAN_DIR = path.join(homedir(), ".opencode", "plan")

export interface Restoration extends Snapshot {
  /** Estimated tokens of each section, by name. */
  sections: Record<string, number>
}

/** The budget grows with the conversation that was compacted, within fixed bounds. */
export function restoreBudget(compactedTokens: number | undefined, window: number) {
  const fromConversation = Math.max(RESTORE_MIN_TOKENS, RESTORE_SHARE * (compactedTokens ?? 0))
  return Math.floor(Math.min(RESTORE_MAX_TOKENS, RESTORE_SHARE * window, fromConversation))
}

/** Lines numbered the way OpenCode's read tool numbers them, starting at `first`. Very long lines are cut. */
const numbered = (lines: string[], first = 1) =>
  lines
    .map((line, index) => `${first + index}: ${line.length > RESTORE_LINE_CHARS ? `${line.slice(0, RESTORE_LINE_CHARS)}…` : line}`)
    .join("\n")

/** A file's lines, without the empty one after a final newline. */
const linesOf = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n")

/**
 * A fenced block that the content can't close early. Markdown, not XML: some models write their tool calls in
 * XML, and XML-looking context such as `<file path="…">` leaked into their tool arguments during evaluation.
 */
function fenced(text: string, language = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

/** Whitespace-insensitive, so a request still counts as present when it was reflowed. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

const isPlan = (record: FileRecord) => record.path.startsWith(PLAN_DIR + path.sep)

/**
 * Builds what goes back into the conversation after a compaction, read fresh from disk. `visible` is the text the
 * request already holds from the checkpoint on, so a user message OpenCode kept isn't repeated.
 * Returns undefined when there is nothing worth restoring.
 */
export async function buildRestoration(
  state: SessionState,
  window: number,
  summaryKey: string,
  visible = "",
): Promise<Restoration | undefined> {
  let budget = restoreBudget(state.compactedTokens, window)
  const sections: string[] = []
  const sizes: Record<string, number> = {}
  const take = (name: string, text: string) => {
    const tokens = estimateTokens(text)
    if (tokens > budget) return false
    budget -= tokens
    sections.push(text)
    sizes[name] = tokens
    return true
  }
  const relative = (file: string) => (state.directory ? path.relative(state.directory, file) || file : file)
  /** Files whose content or changes are shown, so they aren't listed again. */
  const shown = new Set<string>()

  // The summary keeps the task only in its own words, and in evaluation it lost about one identifier in five.
  const present = normalize(visible)
  const [first, ...later] = state.requests ?? []
  const parts: string[] = []
  if (first && !present.includes(normalize(first))) {
    parts.push(`The user's request, word for word. Where the summary leaves out a detail, it is here.\n\n${fenced(keepEnds(first, RESTORE_TASK_TOKENS))}`)
  }
  const missing = later.filter((request) => !present.includes(normalize(request)))
  if (missing.length > 0) {
    parts.push(
      `${parts.length > 0 ? "The user's later messages" : "The user's latest messages"}, oldest first:\n\n${missing
        .map((request) => fenced(keepEnds(request, RESTORE_REQUEST_TOKENS)))
        .join("\n\n")}`,
    )
  }
  if (parts.length > 0) take("task", `## Your task\n\n${parts.join("\n\n")}`)

  const work: string[] = []
  if (state.calls?.length) {
    work.push(`Your last tool calls, oldest first:\n\n${state.calls.map((call) => `- ${call.what}${call.outcome ? `: ${call.outcome}` : ""}`).join("\n")}`)
  }
  const test = state.lastTest
  if (test) {
    const ending = test.exit === undefined ? "" : `, which ended with exit ${test.exit}`
    work.push(`Your latest test run was \`${test.command}\`${ending}. The end of its output:\n\n${fenced(test.tail || "(no output)")}`)
  }
  if (work.length > 0) take("state", `## Where you left off\n\n${work.join("\n\n")}`)

  const records = Object.values(state.files)
  const edited = records.filter((record) => record.editedAt && !isPlan(record)).sort((a, b) => (b.editedAt ?? 0) - (a.editedAt ?? 0))
  if (edited.length > 0) {
    const changes = await describeChanges(state, edited, relative, budget)
    if (changes && take("changes", changes.text)) for (const file of changes.files) shown.add(file)
  }

  // The parts of read-only files the agent read last. Picked by when they were used: files from a fresh checkout all
  // share one change time, so ordering by it picked read-only files at random.
  const reading: string[] = []
  for (const record of records.filter((record) => !record.editedAt && record.ranges?.length && !isPlan(record)).sort((a, b) => lastUsed(b) - lastUsed(a))) {
    if (reading.length >= RESTORE_READ_FILES) break
    const text = await readText(record.path)
    if (text === undefined) continue
    const lines = linesOf(text)
    const chosen: [number, number][] = []
    let tokens = 0
    for (const [start, end] of [...(record.ranges ?? [])].reverse()) {
      if (start > lines.length) continue
      const size = estimateTokens(numbered(lines.slice(start - 1, Math.min(end, lines.length)), start))
      if (tokens + size > RESTORE_READ_TOKENS) break
      tokens += size
      chosen.push([start, Math.min(end, lines.length)])
    }
    if (chosen.length === 0) continue
    chosen.sort((a, b) => a[0] - b[0])
    const label = chosen.map(([start, end]) => `${start}-${end}`).join(", ")
    const body = chosen.map(([start, end]) => fenced(numbered(lines.slice(start - 1, end), start))).join("\n\n")
    reading.push(`### ${relative(record.path)}, lines ${label}\n\n${body}`)
    shown.add(record.path)
  }
  if (reading.length > 0) {
    take("reading", `## Code you were reading\n\nThe parts of these files you read last, as they are on disk now, with line numbers.\n\n${reading.join("\n\n")}`)
  }

  if (state.notes.length > 0) take("notes", `## Your latest progress notes\n\n${state.notes.map((note) => `- ${note}`).join("\n")}`)

  const planRecord = records.filter((record) => record.editedAt && isPlan(record)).sort((a, b) => lastUsed(b) - lastUsed(a))[0]
  const planText = planRecord && (await readText(planRecord.path))
  if (planRecord && planText) take("plan", `## Plan (${planRecord.path})\n\n${keepStart(planText, RESTORE_PLAN_TOKENS)}`)

  // Without this list, an agent that saw some files restored stopped looking at the others, and missed uses of a
  // function it was asked to rename everywhere.
  const others: string[] = []
  for (const record of records.filter((record) => !shown.has(record.path) && !isPlan(record)).sort((a, b) => lastUsed(b) - lastUsed(a))) {
    if (others.length >= RESTORE_OTHER_FILES) break
    if (await diskState(record.path)) others.push(`- ${relative(record.path)}`)
  }
  if (others.length > 0) {
    take("others", `## Other files you used earlier\n\nNot restored. Read them again when your task touches them.\n\n${others.join("\n")}`)
  }

  // Newest skills first. Each keeps its start, since instructions near the top matter most.
  const skillSections: string[] = []
  let skillBudget = Math.min(RESTORE_SKILLS_TOTAL, budget)
  for (const skill of Object.values(state.skills).sort((a, b) => b.at - a.at)) {
    const body = `### Skill: ${skill.name}\n\n${keepStart(skill.text, RESTORE_SKILL_TOKENS)}`
    const tokens = estimateTokens(body)
    if (tokens > skillBudget) break
    skillBudget -= tokens
    skillSections.push(body)
  }
  if (skillSections.length > 0) {
    take(
      "skills",
      `## Skills you loaded earlier\n\nTheir instructions still apply. You already ran them for the request that loaded them, so don't run them again for that request.\n\n${skillSections.join("\n\n")}`,
    )
  }

  if (sections.length === 0) return undefined
  const text = [
    "<restored-context>",
    "The conversation was compacted. Carry on from where you left off; don't start the task over. The code and changes below were read from disk right after the compaction, so you don't need to read them again unless they change.",
    "This is only what you used recently, not the whole project. Before a change that may reach other files, such as a rename, search the code for every place it affects.",
    "",
    sections.join("\n\n"),
    ...(edited.length > 0
      ? ["", "Before you finish:", "- Check your changes against each point of the user's request.", "- Run the tests that cover your changes."]
      : []),
    "</restored-context>",
  ].join("\n")
  return { text, tokens: estimateTokens(text), at: Date.now(), summaryKey, sections: sizes }
}

/**
 * The "Files you changed" section: the files the agent edited, whole and as they are now, the most recently edited
 * first, then the working tree's `git status --short`. A file too large to restore whole comes back as its `git diff`.
 * In evaluation, agents shown only a diff of their files read them again before they could edit them, while agents
 * shown the whole files carried on editing. The status answers the `git status` many agents ran first after compaction.
 */
async function describeChanges(state: SessionState, edited: FileRecord[], relative: (file: string) => string, limit: number) {
  const parts: string[] = []
  const restored: string[] = []
  // Some room is left for the headings.
  let room = limit - 200
  const whole: string[] = []
  const large: string[] = []
  for (const record of edited.slice(0, RESTORE_FILES)) {
    const text = await readText(record.path)
    if (text === undefined) continue
    const content = numbered(linesOf(text))
    const tokens = estimateTokens(content)
    if (tokens <= RESTORE_FILE_TOKENS && tokens <= room) {
      room -= tokens
      whole.push(`### ${relative(record.path)}\n\n${fenced(content)}`)
      restored.push(record.path)
    } else large.push(record.path)
  }
  if (whole.length > 0) parts.push(`Their current contents, with line numbers:\n\n${whole.join("\n\n")}`)

  const directory = state.directory ?? process.cwd()
  let context = RESTORE_DIFF_CONTEXT
  let changes = await changesOf(directory, large, context)
  const size = (diffs: Map<string, string>) => estimateTokens([...diffs.values()].join("\n"))
  if (changes && size(changes.diffs) > RESTORE_DIFF_TOKENS) {
    context = 3
    changes = (await changesOf(directory, large, context)) ?? changes
  }
  const diffs: string[] = []
  let budget = Math.min(RESTORE_DIFF_TOKENS, room)
  for (const file of large) {
    const diff = changes?.diffs.get(file)
    if (!diff || estimateTokens(diff) > budget) continue
    budget -= estimateTokens(diff)
    room -= estimateTokens(diff)
    diffs.push(diff)
    restored.push(file)
  }
  if (diffs.length > 0) {
    parts.push(`Too large to show whole, so here is \`git diff HEAD\` with ${context} lines of context:\n\n${fenced(diffs.join("\n"), "diff")}`)
  }
  const left = large.filter((file) => !restored.includes(file))
  if (left.length > 0) parts.push(`Also changed, too large to show here: ${left.map(relative).join(", ")}. Read them again when you need them.`)

  if (changes && changes.status.length > 0) {
    const lines = changes.status.slice(0, RESTORE_STATUS_LINES)
    const more = changes.status.length - lines.length
    const status = `\`git status --short\`:\n\n${fenced(lines.join("\n") + (more > 0 ? `\n… and ${more} more` : ""))}`
    if (estimateTokens(status) <= room) parts.push(status)
  }

  if (parts.length === 0) return undefined
  return { text: `## Files you changed\n\n${parts.join("\n\n")}`, files: restored }
}

export function describeRestoration(restoration: Restoration): string {
  const names = Object.keys(restoration.sections)
  return `lodestar restored ${names.length > 0 ? names.join(", ") : "nothing"} after compaction (~${Math.max(1, Math.round(restoration.tokens / 1000))}k tokens).`
}

/** Identifies a summary, to tell whether a snapshot belongs to the current checkpoint. */
export const summaryKeyOf = (summary: string) => createHash("sha256").update(summary.trim()).digest("hex")

/** Pulls the summary out of the checkpoint message OpenCode builds. */
export function summaryFromCheckpoint(text: string): string {
  const match = text.match(/<summary>\n([\s\S]*?)\n<\/summary>/)
  return match?.[1] ?? text
}
