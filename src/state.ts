import type { StorageDomain } from "@opencode/plugin/promise/storage"

export interface DiskState {
  mtimeMs: number
  size: number
}

export interface FileRecord {
  path: string
  readAt?: number
  editedAt?: number
  /** The file as the agent last saw it, through its own read or edit. */
  seen?: DiskState
  /** A change already reported to the agent, so the notice isn't repeated. */
  reported?: DiskState | "deleted"
  /** Line ranges the agent read, oldest first, with overlapping ones merged. */
  ranges?: [number, number][]
}

export interface SkillRecord {
  name: string
  text: string
  at: number
}

/** One of the agent's tool calls, described for the restoration, such as "shell `go test ./...`" and "exit 1". */
export interface CallRecord {
  what: string
  outcome?: string
}

/** The agent's latest test command and how it ended. */
export interface TestRun {
  command: string
  exit?: number
  /** The end of its output. */
  tail: string
}

export interface Snapshot {
  text: string
  tokens: number
  at: number
  /** Hash of the summary it was made for. A newer checkpoint needs a new snapshot. */
  summaryKey: string
  /** A one-line description for the trace, such as "lodestar restored 3 files". */
  note?: string
}

export interface SessionState {
  directory?: string
  files: Record<string, FileRecord>
  notes: string[]
  skills: Record<string, SkillRecord>
  /** Tool calls since the agent last wrote to the user. */
  toolStreak: number
  /** A recap was already requested during this streak. */
  recited: boolean
  /** The user's requests in this session, word for word: the first one, then the latest few. */
  requests?: string[]
  /** The agent's latest tool calls, oldest first. */
  calls?: CallRecord[]
  lastTest?: TestRun
  /** When the agent's recent shell commands ran. A file that changed during one was changed by the agent. */
  shellRuns?: { start: number; end: number }[]
  /** Estimated size of the conversation at the last compaction. */
  compactedTokens?: number
  /** What gets put back after the last compaction. It stays fixed until the next one. */
  snapshot?: Snapshot
}

const empty = (): SessionState => ({ files: {}, notes: [], skills: {}, toolStreak: 0, recited: false })

/** Per-session state, kept in memory and saved to plugin storage so it survives a restart. */
export class Store {
  private readonly cache = new Map<string, SessionState>()
  private readonly loading = new Map<string, Promise<SessionState>>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly storage: StorageDomain) {}

  private key(sessionID: string) {
    return `session/${sessionID}`
  }

  async get(sessionID: string): Promise<SessionState> {
    const cached = this.cache.get(sessionID)
    if (cached) return cached
    let loading = this.loading.get(sessionID)
    if (!loading) {
      loading = this.storage
        .get(this.key(sessionID))
        .catch(() => undefined)
        .then((value) => {
          const state = { ...empty(), ...((value as Partial<SessionState> | undefined) ?? {}) }
          this.cache.set(sessionID, state)
          this.loading.delete(sessionID)
          return state
        })
      this.loading.set(sessionID, loading)
    }
    return loading
  }

  /** Saves shortly after the last change, so a burst of tool calls costs one write. */
  save(sessionID: string) {
    clearTimeout(this.pending.get(sessionID))
    this.pending.set(
      sessionID,
      setTimeout(() => {
        this.pending.delete(sessionID)
        const state = this.cache.get(sessionID)
        if (state) void this.storage.set(this.key(sessionID), JSON.parse(JSON.stringify(state))).catch(() => {})
      }, 200),
    )
  }

  async remove(sessionID: string) {
    clearTimeout(this.pending.get(sessionID))
    this.pending.delete(sessionID)
    this.cache.delete(sessionID)
    await this.storage.remove(this.key(sessionID)).catch(() => {})
  }
}
