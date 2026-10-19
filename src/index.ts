import { appendFile } from "node:fs/promises"
import type { Message } from "@opencode/ai"
import { Plugin } from "@opencode/plugin"
import { recordShellRun, recordTool, SHELL_TOOLS } from "./files"
import { PROGRESS_NOTE_CHARS, PROGRESS_NOTES } from "./limits"
import { checkpointIndex, insertNearEnd, textOf, userMessage } from "./messages"
import { recitation, staleFiles, staleNotice } from "./reminders"
import { buildRestoration, describeRestoration, summaryFromCheckpoint, summaryKeyOf } from "./restore"
import { Store, type SessionState, type Snapshot } from "./state"
import { estimateTokens } from "./tokens"

type Feature = "T2" | "T4" | "T6"
type ModelRef = { readonly providerID: string; readonly id: string }

/** Used when a model's context window can't be looked up. */
const DEFAULT_WINDOW = 200_000

export default Plugin.define({
  id: "opencode-lodestar",
  async setup(ctx) {
    // Switches for the evaluation harness, not user settings. See eval/README.md.
    const disabled = new Set((process.env.LODESTAR_DISABLE ?? "").split(",").map((name) => name.trim().toUpperCase()))
    const on = (feature: Feature) => !disabled.has(feature)
    const tracePath = process.env.LODESTAR_TRACE
    const trace = (entry: Record<string, unknown>) => {
      if (tracePath) void appendFile(tracePath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`).catch(() => {})
    }

    const store = new Store(ctx.storage)
    const registrations: { dispose: () => Promise<void> }[] = []

    const windows = new Map<string, number>()
    async function contextWindow(model: ModelRef | undefined): Promise<number> {
      if (!model) return DEFAULT_WINDOW
      const key = `${model.providerID}/${model.id}`
      const known = windows.get(key)
      if (known) return known
      try {
        const result = (await ctx.model.list()) as unknown
        const models = (Array.isArray(result) ? result : ((result as { data?: unknown[] }).data ?? [])) as {
          id?: string
          modelID?: string
          providerID?: string
          limit?: { context?: number }
        }[]
        const info = models.find(
          (candidate) => candidate.providerID === model.providerID && (candidate.modelID ?? candidate.id) === model.id,
        )
        const window = info?.limit?.context ?? DEFAULT_WINDOW
        windows.set(key, window)
        return window
      } catch {
        return DEFAULT_WINDOW
      }
    }

    async function directoryOf(sessionID: string, state: SessionState): Promise<string> {
      if (!state.directory) {
        try {
          const info = (await ctx.session.get({ sessionID: sessionID as never })) as { location?: { directory?: string } }
          state.directory = info.location?.directory
        } catch {}
      }
      return state.directory ?? process.cwd()
    }

    // One restoration per checkpoint, whichever of the compaction event and the next request asks first.
    const building = new Map<string, Promise<Snapshot | undefined>>()
    function ensureSnapshot(sessionID: string, summary: string, model: ModelRef | undefined) {
      const running = building.get(sessionID)
      if (running) return running
      const job = (async () => {
        const state = await store.get(sessionID)
        const key = summaryKeyOf(summary)
        if (state.snapshot?.summaryKey === key) return state.snapshot
        await directoryOf(sessionID, state)
        const restoration = await buildRestoration(state, await contextWindow(model), key)
        state.snapshot = restoration
          ? { text: restoration.text, tokens: restoration.tokens, at: restoration.at, summaryKey: key, note: describeRestoration(restoration) }
          : { text: "", tokens: 0, at: Date.now(), summaryKey: key }
        store.save(sessionID)
        trace({ sessionID, feature: "T2", event: "snapshot", tokens: state.snapshot.tokens, note: state.snapshot.note })
        return state.snapshot
      })().finally(() => building.delete(sessionID))
      building.set(sessionID, job)
      return job
    }

    /** Puts the restoration right after the checkpoint, where it stays until the next compaction. */
    async function restoreInto(sessionID: string, messages: Message[], model: ModelRef | undefined) {
      const index = checkpointIndex(messages)
      const checkpoint = messages[index]
      if (!checkpoint) return
      const snapshot = await ensureSnapshot(sessionID, summaryFromCheckpoint(textOf(checkpoint)), model)
      const message = snapshot?.text ? userMessage(messages, snapshot.text) : undefined
      if (message) messages.splice(index + 1, 0, message)
    }

    // When each shell command started, so T6 can tell the agent's own changes, such as a formatter's, from outside ones.
    const shellStarts = new Map<string, number>()
    registrations.push(
      await ctx.tool.hook("execute.before", async (event) => {
        if (SHELL_TOOLS.has(event.tool)) shellStarts.set(event.id, Date.now())
      }),
    )

    // T1: what the agent reads and changes. T4 counts the calls; T6 remembers how each file looked.
    registrations.push(
      await ctx.tool.hook("execute.after", async (event) => {
        const state = await store.get(event.sessionID)
        state.toolStreak++
        if (SHELL_TOOLS.has(event.tool)) {
          const now = Date.now()
          recordShellRun(state, shellStarts.get(event.id) ?? now, now)
          shellStarts.delete(event.id)
        }
        if (event.status === "completed") {
          await recordTool(state, {
            tool: event.tool,
            input: event.input,
            output: event.result.output,
            directory: await directoryOf(event.sessionID, state),
            now: Date.now(),
          })
        }
        store.save(event.sessionID)
      }),
    )

    // How big the conversation was when OpenCode compacted it. That sets how much T2 may restore.
    // The compaction request is built apart from the agent's requests, so it gets the restoration too. Without it, the
    // request no longer matched the ones before it after the checkpoint, and the provider billed everything from there
    // on as uncached input: 38k tokens per compaction in evaluation, against 5k without lodestar.
    registrations.push(
      await ctx.session.hook("compaction", async (event) => {
        const state = await store.get(event.sessionID)
        const messages = event.messages as Message[]
        state.compactedTokens = estimateTokens(JSON.stringify(messages.map((message) => (message as { content?: unknown }).content)))
        store.save(event.sessionID)
        if (on("T2")) await restoreInto(event.sessionID, messages, event.model)
      }),
    )

    // T2, T6, T4: additions to each request. None of them is saved in the session.
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        const state = await store.get(event.sessionID)
        const messages = event.messages as Message[]
        let changed = false
        if (on("T2")) await restoreInto(event.sessionID, messages, event.model)
        if (on("T6")) {
          const files = await staleFiles(state)
          const notice = staleNotice(state, files)
          const message = notice ? userMessage(messages, notice) : undefined
          if (files.changed.length + files.deleted.length > 0) changed = true
          if (message) {
            insertNearEnd(messages, message)
            trace({ sessionID: event.sessionID, feature: "T6", changed: files.changed, deleted: files.deleted })
          }
        }
        if (on("T4")) {
          const reminder = recitation(state)
          const message = reminder ? userMessage(messages, reminder) : undefined
          if (message) {
            insertNearEnd(messages, message)
            state.recited = true
            changed = true
            trace({ sessionID: event.sessionID, feature: "T4", toolStreak: state.toolStreak })
          }
        }
        if (changed) store.save(event.sessionID)
      }),
    )

    const abort = new AbortController()
    async function handle(event: { type: string; data?: Record<string, unknown> }) {
      const data = event.data ?? {}
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return
      if (event.type === "session.deleted") return store.remove(sessionID)
      const state = await store.get(sessionID)
      if (event.type === "session.text.ended" && typeof data.text === "string" && data.text.trim()) {
        if (state.toolStreak > 0) {
          const note = data.text.trim().replace(/\s+/g, " ")
          state.notes = [...state.notes, note.length > PROGRESS_NOTE_CHARS ? `${note.slice(0, PROGRESS_NOTE_CHARS)}…` : note].slice(
            -PROGRESS_NOTES,
          )
        }
        state.toolStreak = 0
        state.recited = false
        store.save(sessionID)
      }
      if (event.type === "session.skill.activated" && typeof data.name === "string" && typeof data.text === "string") {
        state.skills[data.name] = { name: data.name, text: data.text, at: Date.now() }
        store.save(sessionID)
      }
      // Built here so it's ready for the first request after the compaction. It isn't announced with a message in the
      // session: OpenCode counts such a message as a new exchange, keeps the turn before it as serialized text in the
      // next checkpoint, and in evaluation that text led a model to break its own tool calls.
      if (event.type === "session.compaction.ended" && on("T2") && typeof data.text === "string") {
        await ensureSnapshot(sessionID, data.text, data.model as ModelRef | undefined)
      }
    }
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            await handle(event as { type: string; data?: Record<string, unknown> }).catch(() => {})
          }
        } catch {}
        if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    return async () => {
      abort.abort()
      for (const registration of registrations) await registration.dispose()
    }
  },
})
