// Compares A and B run by run: the same task, model, and repeat, once without lodestar and once with it.
// usage: bun eval/compare.ts [--tasks] [--model <part of a model name>] <results.jsonl>...
import type { Metrics } from "./lib/metrics"
import type { RunResult } from "./lib/result"

type Pair = { a: RunResult; b: RunResult }

const args = Bun.argv.slice(2)
const showTasks = args.includes("--tasks")
const modelAt = args.indexOf("--model")
const onlyModel = modelAt >= 0 ? args[modelAt + 1] : undefined
const files = args.filter((arg, index) => arg !== "--tasks" && arg !== "--model" && index !== modelAt + 1)
const results: RunResult[] = []
for (const file of files) {
  for (const line of (await Bun.file(file).text()).split("\n")) {
    if (!line.trim()) continue
    const result = JSON.parse(line) as RunResult
    if (!onlyModel || result.model.includes(onlyModel)) results.push(result)
  }
}
if (results.length === 0) throw new Error("usage: bun eval/compare.ts [--tasks] [--model <part of a model name>] <results.jsonl>...")

const byName = new Map<string, { a?: RunResult; b?: RunResult }>()
for (const result of results) {
  if (!result.ok) continue
  const name = [result.model, result.task, result.repeat].join("\u0000")
  const pair = byName.get(name) ?? {}
  if (result.config === "A") pair.a = result
  if (result.config === "B") pair.b = result
  byName.set(name, pair)
}
const pairs = [...byName.values()].filter((pair): pair is Pair => Boolean(pair.a && pair.b))

// A fixed seed, so the same results always give the same intervals.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

/** Mean of the B minus A differences, with a 95% bootstrap interval over pairs. */
function meanDifference(differences: number[]) {
  const next = random(1)
  const means = Array.from({ length: 2000 }, () => mean(differences.map(() => differences[Math.floor(next() * differences.length)] ?? 0))).sort(
    (x, y) => x - y,
  )
  return { mean: mean(differences), low: means[50] ?? 0, high: means[1949] ?? 0 }
}

const minutes = (result: RunResult) => (result.metrics?.durationMs ?? 0) / 60_000
const metric = (pick: (metrics: Metrics) => number) => (result: RunResult) => (result.metrics ? pick(result.metrics) : 0)
const thousands = (digits: number) => (value: number) => `${(value / 1000).toFixed(digits)}k`
// Providers with explicit caching, such as Qwen through OpenCode Go, report new prompt tokens as cache writes.
const MEASURES: [string, (result: RunResult) => number, (value: number) => string][] = [
  ["Prompt tokens", metric((metrics) => metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.cacheWrite), thousands(0)],
  ["Uncached prompt tokens", metric((metrics) => metrics.tokens.input + metrics.tokens.cacheWrite), thousands(0)],
  ["Output tokens", metric((metrics) => metrics.tokens.output), thousands(1)],
  ["Tool calls", metric((metrics) => metrics.toolCalls), (value) => value.toFixed(0)],
  ["Files read again after compaction", metric((metrics) => metrics.rereadsAfterCompaction), (value) => value.toFixed(1)],
  ["Compactions", metric((metrics) => metrics.compactions), (value) => value.toFixed(1)],
  ["Minutes", minutes, (value) => value.toFixed(1)],
  ["Cost (USD, OpenCode Go only)", metric((metrics) => metrics.cost), (value) => value.toFixed(3)],
]

const compacted = (pair: Pair) => (pair.a.metrics?.compactions ?? 0) + (pair.b.metrics?.compactions ?? 0) > 0
const bothCompacted = (pair: Pair) => (pair.a.metrics?.compactions ?? 0) > 0 && (pair.b.metrics?.compactions ?? 0) > 0

function summarize(title: string, matched: Pair[]) {
  if (matched.length === 0) return
  const solved = (result: RunResult) => Boolean(result.check?.success)
  const both = matched.filter(({ a, b }) => solved(a) && solved(b)).length
  const onlyB = matched.filter(({ a, b }) => solved(b) && !solved(a)).length
  const onlyA = matched.filter(({ a, b }) => solved(a) && !solved(b)).length
  console.log(`### ${title}\n`)
  console.log(
    `${matched.length} pairs. Resolved: A ${both + onlyA}, B ${both + onlyB}. Both ${both}, only with lodestar ${onlyB}, only without ${onlyA}, neither ${matched.length - both - onlyA - onlyB}.\n`,
  )
  console.log("| Per run | A | B | Change | B minus A (95% interval) |")
  console.log("| --- | --- | --- | --- | --- |")
  for (const [name, pick, format] of MEASURES) {
    const a = mean(matched.map(({ a }) => pick(a)))
    const b = mean(matched.map(({ b }) => pick(b)))
    const change = a === 0 ? "" : `${b >= a ? "+" : ""}${Math.round(((b - a) / a) * 100)}%`
    const difference = meanDifference(matched.map(({ a, b }) => pick(b) - pick(a)))
    console.log(`| ${name} | ${format(a)} | ${format(b)} | ${change} | ${format(difference.mean)} (${format(difference.low)} to ${format(difference.high)}) |`)
  }
  console.log()
}

console.log(onlyModel ? `## Models matching ${onlyModel}\n` : "## All models\n")
summarize("All pairs", pairs)
summarize("Pairs where A or B compacted", pairs.filter(compacted))
summarize("Pairs where both compacted", pairs.filter(bothCompacted))

const mark = (result: RunResult) => (result.check?.success ? "yes" : "no")
for (const model of [...new Set(pairs.map((pair) => pair.a.model))].sort()) {
  const matched = pairs.filter((pair) => pair.a.model === model)
  console.log(`## ${model}\n`)
  summarize("All pairs", matched)
  summarize("Pairs where A or B compacted", matched.filter(compacted))
  summarize("Pairs where both compacted", matched.filter(bothCompacted))
  if (!showTasks) continue
  console.log("| Task | Resolved A | Resolved B | Minutes A | Minutes B | Compactions A | Compactions B | Peak prompt A | Peak prompt B |")
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const { a, b } of matched) {
    const peak = (result: RunResult) => `${((result.peakPrompt ?? 0) / 1000).toFixed(0)}k`
    console.log(
      `| ${a.task.replace(/^instance_/, "").slice(0, 48)} | ${mark(a)} | ${mark(b)} | ${minutes(a).toFixed(1)} | ${minutes(b).toFixed(1)} | ${a.metrics?.compactions ?? 0} | ${b.metrics?.compactions ?? 0} | ${peak(a)} | ${peak(b)} |`,
    )
  }
  console.log()
}

const errors = results.filter((result) => !result.ok)
if (errors.length > 0) {
  console.log("## Runs that didn't count\n")
  for (const result of errors) console.log(`- ${result.model} ${result.config} ${result.task} #${result.repeat}: ${result.error}`)
}
