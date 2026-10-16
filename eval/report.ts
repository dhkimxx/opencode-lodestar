// Summarizes one or more results.jsonl files as Markdown tables.
// usage: bun eval/report.ts <results.jsonl>...
import type { RunResult } from "./run"

const results: RunResult[] = []
for (const file of Bun.argv.slice(2)) {
  for (const line of (await Bun.file(file).text()).split("\n")) if (line.trim()) results.push(JSON.parse(line) as RunResult)
}
if (results.length === 0) throw new Error("usage: bun eval/report.ts <results.jsonl>...")

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
const percent = (value: number) => `${Math.round(value * 100)}%`
const thousands = (value: number) => `${(value / 1000).toFixed(1)}k`

interface Row {
  runs: number
  errors: number
  success: number
  score: number
  violations: number
  promptTokens: number
  outputTokens: number
  cacheHitRate: number
  cost: number
  rereadsAfterCompaction: number
  failedEdits: number
  repeatedEdits: number
  compactions: number
  minutes: number
}

function summarize(group: RunResult[]): Row {
  const ok = group.filter((result) => result.ok && result.check && result.metrics)
  const metric = (pick: (result: RunResult) => number) => mean(ok.map(pick))
  return {
    runs: group.length,
    errors: group.length - ok.length,
    success: ok.length ? ok.filter((result) => result.check?.success).length / ok.length : 0,
    score: metric((result) => result.check?.score ?? 0),
    violations: ok.reduce((sum, result) => sum + (result.check?.violations ?? 0), 0),
    promptTokens: metric((result) => (result.metrics?.tokens.input ?? 0) + (result.metrics?.tokens.cacheRead ?? 0)),
    outputTokens: metric((result) => result.metrics?.tokens.output ?? 0),
    cacheHitRate: metric((result) => result.metrics?.cacheHitRate ?? 0),
    cost: metric((result) => result.metrics?.cost ?? 0),
    rereadsAfterCompaction: metric((result) => result.metrics?.rereadsAfterCompaction ?? 0),
    failedEdits: metric((result) => result.metrics?.failedEdits ?? 0),
    repeatedEdits: metric((result) => result.metrics?.repeatedEdits ?? 0),
    compactions: metric((result) => result.metrics?.compactions ?? 0),
    minutes: metric((result) => (result.metrics?.durationMs ?? 0) / 60_000),
  }
}

const HEADER =
  "| Model | Config | Scenario | Runs | Errors | Success | Score | Violations | Prompt tokens | Output tokens | Cache hit | Cost | Re-reads after compaction | Failed edits | Repeated edits | Compactions | Minutes |"
const DIVIDER = `|${" --- |".repeat(HEADER.split("|").length - 2)}`

function line(model: string, config: string, scenario: string, row: Row) {
  return `| ${model} | ${config} | ${scenario} | ${row.runs} | ${row.errors} | ${percent(row.success)} | ${row.score.toFixed(2)} | ${row.violations} | ${thousands(row.promptTokens)} | ${thousands(row.outputTokens)} | ${percent(row.cacheHitRate)} | $${row.cost.toFixed(3)} | ${row.rereadsAfterCompaction.toFixed(1)} | ${row.failedEdits.toFixed(1)} | ${row.repeatedEdits.toFixed(1)} | ${row.compactions.toFixed(1)} | ${row.minutes.toFixed(1)} |`
}

const key = (...parts: string[]) => parts.join("\u0000")
const groups = new Map<string, RunResult[]>()
const totals = new Map<string, RunResult[]>()
for (const result of results) {
  const byScenario = key(result.model, result.config, result.scenario)
  groups.set(byScenario, [...(groups.get(byScenario) ?? []), result])
  const byConfig = key(result.model, result.config)
  totals.set(byConfig, [...(totals.get(byConfig) ?? []), result])
}

console.log("## By scenario\n")
console.log(HEADER)
console.log(DIVIDER)
for (const name of [...groups.keys()].sort()) {
  const [model = "", config = "", scenario = ""] = name.split("\u0000")
  console.log(line(model, config, scenario, summarize(groups.get(name) ?? [])))
}

console.log("\n## All scenarios\n")
console.log(HEADER)
console.log(DIVIDER)
for (const name of [...totals.keys()].sort()) {
  const [model = "", config = ""] = name.split("\u0000")
  console.log(line(model, config, "all", summarize(totals.get(name) ?? [])))
}
