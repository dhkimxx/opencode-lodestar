import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { diskState, lastUsed, readText } from "./files"
import {
  RESTORE_FILE_TOKENS,
  RESTORE_FILES,
  RESTORE_MAX_TOKENS,
  RESTORE_MIN_TOKENS,
  RESTORE_PLAN_TOKENS,
  RESTORE_SHARE,
  RESTORE_SKILL_TOKENS,
  RESTORE_SKILLS_TOTAL,
} from "./limits"
import type { SessionState, Snapshot, TodoItem } from "./state"
import { estimateTokens, keepStart } from "./tokens"

/** Where OpenCode's plan mode writes plans. */
export const PLAN_DIR = path.join(homedir(), ".opencode", "plan")

export interface Restoration extends Snapshot {
  files: number
  references: number
  skills: number
  plan: boolean
  todo: boolean
}

export function formatTodo(items: readonly TodoItem[]): string {
  const mark = { done: "x", in_progress: "~", pending: " " } as const
  return items.map((item) => `- [${mark[item.status]}] ${item.text}`).join("\n")
}

/** The budget grows with the conversation that was compacted, within fixed bounds. */
export function restoreBudget(compactedTokens: number | undefined, window: number) {
  const fromConversation = Math.max(RESTORE_MIN_TOKENS, RESTORE_SHARE * (compactedTokens ?? 0))
  return Math.floor(Math.min(RESTORE_MAX_TOKENS, RESTORE_SHARE * window, fromConversation))
}

const numbered = (text: string) =>
  text
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n")

/**
 * Builds what goes back into the conversation after a compaction, read fresh from disk.
 * Returns undefined when there is nothing worth restoring.
 */
export async function buildRestoration(state: SessionState, window: number, summaryKey: string): Promise<Restoration | undefined> {
  let budget = restoreBudget(state.compactedTokens, window)
  const sections: string[] = []
  const take = (text: string) => {
    const tokens = estimateTokens(text)
    if (tokens > budget) return false
    budget -= tokens
    sections.push(text)
    return true
  }
  const relative = (file: string) => (state.directory ? path.relative(state.directory, file) || file : file)

  const todo = state.todo.length > 0 && take(`## Todo list\n\n${formatTodo(state.todo)}`)
  if (state.notes.length > 0) take(`## Your latest progress notes\n\n${state.notes.map((note) => `- ${note}`).join("\n")}`)

  const records = Object.values(state.files)
  const planRecord = records
    .filter((record) => record.editedAt && record.path.startsWith(PLAN_DIR + path.sep))
    .sort((a, b) => lastUsed(b) - lastUsed(a))[0]
  const planText = planRecord && (await readText(planRecord.path))
  const plan = !!planText && take(`## Plan (${planRecord.path})\n\n${keepStart(planText, RESTORE_PLAN_TOKENS)}`)

  // Claude Code's rule: the files read or edited in this session that changed on disk most recently.
  const candidates = await Promise.all(
    records
      .filter((record) => !record.path.startsWith(PLAN_DIR + path.sep))
      .map(async (record) => ({ record, disk: await diskState(record.path) })),
  )
  const recent = candidates
    .flatMap((candidate) => (candidate.disk ? [{ ...candidate, disk: candidate.disk }] : []))
    .sort((a, b) => b.disk.mtimeMs - a.disk.mtimeMs || lastUsed(b.record) - lastUsed(a.record))
    .slice(0, RESTORE_FILES)
  const fileSections: string[] = []
  let files = 0
  let references = 0
  for (const { record } of recent) {
    const text = await readText(record.path)
    if (text === undefined) continue
    const content = numbered(text)
    const tokens = estimateTokens(content)
    const full = `<file path="${relative(record.path)}">\n${content}\n</file>`
    if (tokens <= RESTORE_FILE_TOKENS && estimateTokens(full) <= budget) {
      budget -= estimateTokens(full)
      fileSections.push(full)
      files++
      continue
    }
    const reference = `<file path="${relative(record.path)}" restored="no">About ${tokens} tokens, too large to restore. Read it again if you need it.</file>`
    if (estimateTokens(reference) <= budget) {
      budget -= estimateTokens(reference)
      fileSections.push(reference)
      references++
    }
  }
  if (fileSections.length > 0) {
    sections.push(`## Files you were working with\n\nCurrent contents, with line numbers.\n\n${fileSections.join("\n\n")}`)
  }

  // Newest skills first. Each keeps its start, since instructions near the top matter most.
  const skillSections: string[] = []
  let skillBudget = RESTORE_SKILLS_TOTAL
  for (const skill of Object.values(state.skills).sort((a, b) => b.at - a.at)) {
    const body = `<skill name="${skill.name}">\n${keepStart(skill.text, RESTORE_SKILL_TOKENS)}\n</skill>`
    const tokens = estimateTokens(body)
    if (tokens > skillBudget || tokens > budget) break
    skillBudget -= tokens
    budget -= tokens
    skillSections.push(body)
  }
  if (skillSections.length > 0) {
    sections.push(
      `## Skills you loaded earlier\n\nTheir instructions still apply. You already ran them for the request that loaded them, so don't run them again for that request.\n\n${skillSections.join("\n\n")}`,
    )
  }

  if (sections.length === 0) return undefined
  const text = [
    "<restored-context>",
    "The conversation was compacted. lodestar read the working context below fresh from disk right after the compaction. Use it instead of reading these files again, unless they may have changed since.",
    "",
    sections.join("\n\n"),
    "</restored-context>",
  ].join("\n")
  return {
    text,
    tokens: estimateTokens(text),
    at: Date.now(),
    summaryKey,
    files,
    references,
    skills: skillSections.length,
    plan,
    todo,
  }
}

export function describeRestoration(restoration: Restoration): string {
  const parts = [
    restoration.files > 0 ? `${restoration.files} file${restoration.files === 1 ? "" : "s"}` : undefined,
    restoration.plan ? "the plan" : undefined,
    restoration.todo ? "the todo list" : undefined,
    restoration.skills > 0 ? `${restoration.skills} skill${restoration.skills === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean)
  const what = parts.length > 0 ? parts.join(", ") : "progress notes"
  return `lodestar restored ${what} after compaction (~${Math.max(1, Math.round(restoration.tokens / 1000))}k tokens).`
}

/** Identifies a summary, to tell whether a snapshot belongs to the current checkpoint. */
export const summaryKeyOf = (summary: string) => createHash("sha256").update(summary.trim()).digest("hex")

/** Pulls the summary out of the checkpoint message OpenCode builds. */
export function summaryFromCheckpoint(text: string): string {
  const match = text.match(/<summary>\n([\s\S]*?)\n<\/summary>/)
  return match?.[1] ?? text
}
