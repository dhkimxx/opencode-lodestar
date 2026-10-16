import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionExport } from "./session"

export type Step =
  | { kind: "turn"; message: string }
  | { kind: "compact" }
  /** Changes files between turns, the way a user editing in their own editor would. */
  | { kind: "edit"; note: string; apply: (workdir: string) => Promise<void> }

export interface CheckResult {
  /** The scenario's goal was met with no violations. */
  success: boolean
  /** Partial credit from 0 to 1. */
  score: number
  /** Broken constraints, such as editing a file the user said not to touch. */
  violations: number
  notes: string[]
}

export interface Scenario {
  id: string
  title: string
  /** Directory under eval/fixtures/ copied into each run. */
  fixture: string
  steps: Step[]
  check: (input: { workdir: string; data: SessionExport }) => Promise<CheckResult>
}

export const turn = (message: string): Step => ({ kind: "turn", message })
export const compact: Step = { kind: "compact" }

export interface TestRun {
  passed: number
  failed: number
  /** Test name to result. */
  results: Map<string, boolean>
  output: string
}

const unescapeXml = (text: string) =>
  text
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

/** Runs `bun test` in the workdir and reads every test's result from a JUnit report. `bun` must be on PATH. */
export async function runTests(workdir: string, files: string[] = []): Promise<TestRun> {
  const report = path.join(tmpdir(), `eval-junit-${crypto.randomUUID()}.xml`)
  // A plain run skips the hidden tests a previous check left behind.
  const scope = files.length > 0 ? files : ["--path-ignore-patterns=.eval-hidden/**"]
  const proc = Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, ...scope], {
    cwd: workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const xml = await Bun.file(report)
    .text()
    .catch(() => "")
  await rm(report, { force: true })
  const results = new Map<string, boolean>()
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = match[1]?.match(/\bname="([^"]*)"/)?.[1]
    if (name === undefined) continue
    results.set(unescapeXml(name), !/<(failure|error)\b/.test(match[2] ?? ""))
  }
  const passed = [...results.values()].filter(Boolean).length
  // A file that fails to load reports no test cases, so count it as a failure.
  const loadFailed = results.size === 0 && /error|fail/i.test(stdout + stderr)
  return { passed, failed: results.size - passed + Number(loadFailed), results, output: stdout + stderr }
}

/**
 * Writes a test the agent never saw into the workdir and runs it.
 * It lives in its own folder so a later `bun test` by a person doesn't trip over it.
 */
export async function runHiddenTest(workdir: string, name: string, source: string): Promise<TestRun> {
  const dir = path.join(workdir, ".eval-hidden")
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${name}.test.ts`)
  await Bun.write(file, source)
  return runTests(workdir, [`./.eval-hidden/${name}.test.ts`])
}

export async function sha256(file: string): Promise<string | undefined> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return undefined
  return new Bun.CryptoHasher("sha256").update(await handle.arrayBuffer()).digest("hex")
}

export const share = (values: boolean[]) => (values.length ? values.filter(Boolean).length / values.length : 0)
