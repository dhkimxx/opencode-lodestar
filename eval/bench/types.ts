// What every harness adapter provides, and the shape their transcripts are reduced to so that the four can be compared.
import type { Task } from "../lib/docker"
import type { Box } from "./box"

/** The evaluation-only ChatGPT login, read once. Only the access token goes into a container. */
export interface Login {
  access: string
  /** Kept out of every container except OpenCode's, whose login format has no way to leave it out. */
  refresh: string
  expires: number
  accountID: string
}

export interface Context {
  box: Box
  task: Task
  /** Where this run's files are collected. */
  root: string
  login: Login
  /** The model's name and reasoning effort, as the harnesses take them. */
  model: string
  effort: string
  /** Seconds the agent gets. */
  budget: number
  /** Auto compaction starts when a request reaches this many tokens. */
  threshold: number
}

export interface AgentRun {
  startedAt: number
  endedAt: number
  /** The budget ran out and the agent was stopped. */
  outOfTime: boolean
  exitCode: number
  /** Why the run doesn't count, such as a provider error, when the agent itself says so. */
  failure?: string
}

export type ToolKind = "read" | "edit" | "shell" | "search" | "other"

/** One tool call, whatever the harness calls it. */
export interface ToolCall {
  type: "tool"
  name: string
  kind: ToolKind
  /** The file a read or an edit touches, when it can be told. */
  file?: string
  ok: boolean
  command?: string
}

export interface Compaction {
  type: "compaction"
  /** How the harness compacted, in its own words. */
  method: string
  /** Seconds after the agent started, when known. */
  at?: number
  tokensBefore?: number
  tokensAfter?: number
}

/** A transcript reduced to what the comparison needs: its tool calls and compactions, in the order they happened. */
export type Trace = (ToolCall | Compaction)[]

export interface Agent {
  id: "A" | "B" | "C" | "D" | "E" | "F" | "G"
  /** What the harness is called in tables. */
  label: string
  /** Puts the credentials and settings in the container. */
  setup(ctx: Context): Promise<void>
  /** Runs the task to the end or until the budget runs out. */
  run(ctx: Context): Promise<AgentRun>
  /** Copies the harness's own logs into ctx.root. */
  collect(ctx: Context): Promise<void>
  /** Reads the collected logs. */
  trace(root: string): Promise<Trace>
}

export const FILE_READERS = /(^|[\s;&|(])(cat|head|tail|nl|less|more|bat|sed\s+-n|awk)\s/
