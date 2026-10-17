// What each run leaves in its result.json, and in results.jsonl beside the others.
import type { Metrics } from "./metrics"

export interface StepLog {
  step: number
  kind: string
  ms: number
  detail?: string
}

export interface RunResult {
  model: string
  /** `A` is OpenCode alone, `B` is OpenCode with lodestar. */
  config: string
  task: string
  repeat: number
  /** False when the run doesn't count, such as when the provider failed. `error` says why. */
  ok: boolean
  error?: string
  /** `success` means the task's verifier passed: every test it names passes. */
  check?: { success: boolean; notes: string[] }
  metrics?: Metrics
  steps: StepLog[]
  /** The size OpenCode compacts against, read from the model's limits. */
  window?: number
  patchBytes?: number
  /** The largest prompt the session sent. */
  peakPrompt?: number
  /** Lines lodestar wrote to its trace, B only. */
  traceLines?: number
}
