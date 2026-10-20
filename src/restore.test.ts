import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordTool } from "./files"
import { buildRestoration, describeRestoration, restoreBudget, summaryFromCheckpoint, summaryKeyOf } from "./restore"
import type { SessionState } from "./state"

let dir = ""
const state = (): SessionState => ({ directory: dir, files: {}, notes: [], skills: {}, toolStreak: 0, recited: false })

async function file(name: string, text: string) {
  const target = path.join(dir, name)
  await writeFile(target, text)
  return target
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n"

const read = (session: SessionState, name: string, now: number, range?: [number, number]) =>
  recordTool(session, {
    tool: "read",
    input: { path: name },
    output: undefined,
    content: range ? [{ type: "text", text: `Read file ${name}, lines ${range[0]}-${range[1]}\n…` }] : undefined,
    directory: dir,
    now,
  })

const edit = (session: SessionState, name: string, now: number) =>
  recordTool(session, { tool: "edit", input: { path: name }, output: undefined, directory: dir, now })

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: dir, stdio: "pipe" })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lodestar-restore-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("restoreBudget", () => {
  test("stays within its bounds", () => {
    expect(restoreBudget(undefined, 1_000_000)).toBe(3_000)
    expect(restoreBudget(40_000, 1_000_000)).toBe(8_000)
    expect(restoreBudget(60_000, 1_000_000)).toBe(12_000)
    expect(restoreBudget(900_000, 1_000_000)).toBe(40_000)
    expect(restoreBudget(900_000, 100_000)).toBe(20_000)
  })
})

describe("buildRestoration", () => {
  test("puts the user's requests back word for word, unless the request still shows them", async () => {
    const session = state()
    session.requests = ["Fix the parser.\nKeep the public API.", "Also handle tabs."]
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("## Your task")
    expect(text).toContain("```\nFix the parser.\nKeep the public API.\n```")
    expect(text).toContain("The user's later messages, oldest first:\n\n```\nAlso handle tabs.\n```")

    const kept = (await buildRestoration(session, 1_000_000, "key", "[User]: Fix the parser. Keep the public API."))?.text ?? ""
    expect(kept).not.toContain("Fix the parser.")
    expect(kept).toContain("The user's latest messages, oldest first:\n\n```\nAlso handle tabs.\n```")
  })

  test("says where the agent left off", async () => {
    const session = state()
    session.calls = [{ what: "read a.ts, lines 1-20" }, { what: "shell `bun test`", outcome: "exit 1" }]
    session.lastTest = { command: "bun test", exit: 1, tail: "1 fail\n3 pass" }
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("Your last tool calls, oldest first:\n\n- read a.ts, lines 1-20\n- shell `bun test`: exit 1")
    expect(text).toContain("Your latest test run was `bun test`, which ended with exit 1. The end of its output:\n\n```\n1 fail\n3 pass\n```")
  })

  test("brings the latest steps back word for word, without reads, within a share of the conversation", async () => {
    const session = state()
    session.compactedTokens = 100_000
    session.recent = [
      { tool: "shell", what: "shell `ls`", outcome: "exit 0", text: "old output" },
      { tool: "read", what: "read a.ts, lines 1-20" },
      { tool: "shell", what: "shell `go test ./...`", outcome: "exit 1", text: "--- FAIL: TestParse" },
      { what: "You wrote", text: "The parser drops the last token." },
    ]
    session.lastTest = { command: "go test ./...", exit: 1, tail: "--- FAIL: TestParse" }
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain(
      "Your last steps, oldest first, with what they returned:\n\n- shell `ls`: exit 0\n\n```\nold output\n```\n\n- shell `go test ./...`: exit 1\n\n```\n--- FAIL: TestParse\n```\n\n- You wrote:\n\n```\nThe parser drops the last token.\n```",
    )
    expect(text).not.toContain("read a.ts")
    expect(text).not.toContain("Your latest test run")

    session.compactedTokens = 100
    const small = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(small).not.toContain("Your last steps")
  })

  test("leaves the latest steps to OpenCode when it kept recent conversation itself", async () => {
    const session = state()
    session.compactedTokens = 100_000
    session.calls = [{ what: "shell `ls`", outcome: "exit 0" }]
    session.recent = [{ tool: "shell", what: "shell `ls`", outcome: "exit 0", text: "a.ts" }]
    const text = (await buildRestoration(session, 1_000_000, "key", "<recent-context>\n[User]: go on\n</recent-context>"))?.text ?? ""
    expect(text).not.toContain("Your last steps")
    expect(text).toContain("Your last tool calls, oldest first:\n\n- shell `ls`: exit 0")
  })

  test("keeps the restoration small when compactions come right after each other", async () => {
    await file("a.ts", "export const a = 1\n")
    const session = state()
    session.compactedTokens = 100_000
    session.requests = ["Fix it."]
    session.recent = [{ tool: "shell", what: "shell `ls`", outcome: "exit 0", text: "a.ts" }]
    session.calls = [{ what: "shell `ls`", outcome: "exit 0" }]
    session.notes = ["Halfway there."]
    await edit(session, "a.ts", 1)
    session.lean = true
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("## Your task")
    expect(text).toContain("Your last tool calls, oldest first:")
    expect(text).not.toContain("## Files you changed")
    expect(text).not.toContain("Halfway there.")
    expect(text).toContain("## Other files you used earlier\n\nNot restored. Read them again when your task touches them.\n\n- a.ts (changed)")
  })

  test("restores the files the agent edited whole, newest edit first, with the working tree's status", async () => {
    await file("a.ts", lines(40))
    git("init", "-q")
    git("add", "-A")
    git("commit", "-qm", "init")
    await file("a.ts", lines(40).replace("line 20\n", "line twenty\n"))
    await file("new.ts", "export const fresh = 1\n")
    const session = state()
    await edit(session, "a.ts", 1)
    await edit(session, "new.ts", 2)
    const restoration = await buildRestoration(session, 1_000_000, "key")
    const text = restoration?.text ?? ""
    expect(text).toContain("## Files you changed\n\nTheir current contents, with line numbers:\n\n### new.ts\n\n```\n1: export const fresh = 1\n```")
    expect(text).toContain("### a.ts\n\n```\n1: line 1\n")
    expect(text).toContain("20: line twenty\n")
    expect(text).not.toContain("```diff")
    expect(text).toContain("`git status --short`:\n\n```\n M a.ts\n?? new.ts\n```")
    expect(text).toContain("Before you finish:")
    expect(text).not.toContain("## Other files you used earlier")
    expect(restoration?.sections.changes).toBeGreaterThan(0)
  })

  test("shows the diff of an edited file too large to restore whole", async () => {
    await file("big.ts", lines(3_000))
    git("init", "-q")
    git("add", "-A")
    git("commit", "-qm", "init")
    await file("big.ts", lines(3_000).replace("line 1500\n", "line fifteen hundred\n"))
    const session = state()
    await edit(session, "big.ts", 1)
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("Too large to show whole, so here is `git diff HEAD` with 10 lines of context:\n\n```diff\ndiff --git a/big.ts b/big.ts")
    expect(text).toContain("-line 1500\n+line fifteen hundred")
    expect(text).not.toContain("1: line 1\n")
  })

  test("restores edited files whole outside a git repository", async () => {
    await file("a.ts", "export const a = 1\n")
    const session = state()
    await edit(session, "a.ts", 1)
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("## Files you changed\n\nTheir current contents, with line numbers:\n\n### a.ts\n\n```\n1: export const a = 1\n```")
    expect(text).not.toContain("git status")
  })

  test("shows the ranges the agent read last in the files it only read, newest files first", async () => {
    const session = state()
    for (const [index, name] of ["old.ts", "big.ts", "mid.ts", "new.ts"].entries()) {
      await file(name, lines(300))
      await read(session, name, index + 1, [100, 120])
    }
    await read(session, "big.ts", 10, [200, 210])
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("## Code you were reading")
    expect(text).toContain("### big.ts, lines 100-120, 200-210\n\n```\n100: line 100")
    expect(text).toContain("210: line 210\n```")
    expect(text).not.toContain("99: line 99")
    expect(text.indexOf("### big.ts")).toBeLessThan(text.indexOf("### new.ts"))
    expect(text).not.toContain("### old.ts")
    expect(text).toContain("## Other files you used earlier\n\nNot restored. Read them again when your task touches them.\n\n- old.ts (read)")
    expect(text).not.toContain("Before you finish:")
  })

  test("leaves out a range too large to show, and lists the file instead", async () => {
    const session = state()
    await file("huge.ts", lines(2_000))
    await read(session, "huge.ts", 1, [1, 2_000])
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).not.toContain("## Code you were reading")
    expect(text).toContain("- huge.ts")
  })

  test("puts notes and skills back, newest skill first", async () => {
    const session = state()
    session.notes = ["The tokenizer handles decimals now."]
    session.skills = {
      old: { name: "old", text: "Old skill body", at: 1 },
      new: { name: "new", text: "New skill body", at: 2 },
    }
    const restoration = await buildRestoration(session, 1_000_000, "key")
    const text = restoration?.text ?? ""
    expect(text).toContain("The tokenizer handles decimals now.")
    expect(text.indexOf("### Skill: new")).toBeLessThan(text.indexOf("### Skill: old"))
    expect(restoration && describeRestoration(restoration)).toBe("lodestar restored notes, skills after compaction (~1k tokens).")
  })

  test("returns nothing when there is nothing to restore", async () => {
    expect(await buildRestoration(state(), 1_000_000, "key")).toBeUndefined()
  })

  test("a file containing backticks gets a longer fence", async () => {
    const session = state()
    await file("notes.md", "```ts\ncode\n```\n")
    await read(session, "notes.md", 1, [1, 3])
    const text = (await buildRestoration(session, 1_000_000, "key"))?.text ?? ""
    expect(text).toContain("### notes.md, lines 1-3\n\n````\n1: ```ts")
    expect(text).not.toMatch(/<file|path="/)
  })
})

test("summaryFromCheckpoint reads the summary out of OpenCode's checkpoint message", () => {
  const checkpoint = "<conversation-checkpoint>\nnote\n\n<summary>\n## Objective\n- fix it\n</summary>\n</conversation-checkpoint>"
  expect(summaryFromCheckpoint(checkpoint)).toBe("## Objective\n- fix it")
})

test("summaries that share an opening still get different keys", () => {
  const opening = "## User requests\n" + "x".repeat(400)
  expect(summaryKeyOf(`${opening}\nfirst`)).not.toBe(summaryKeyOf(`${opening}\nsecond`))
  expect(summaryKeyOf(" same ")).toBe(summaryKeyOf("same"))
})
