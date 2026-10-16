import { appendFile } from "node:fs/promises"
import type { Message } from "@opencode/ai"
import { Plugin } from "@opencode/plugin"
import { recordTool } from "./files"
import { PROGRESS_NOTE_CHARS, PROGRESS_NOTES } from "./limits"
import { checkpointIndex, insertNearEnd, textOf, userMessage } from "./messages"
import { recitation, staleFiles, staleNotice } from "./reminders"
import { buildRestoration, describeRestoration, summaryFromCheckpoint, summaryKeyOf } from "./restore"
import { Store, type SessionState, type Snapshot } from "./state"
import { estimateUsage, looksLikeCheckpoint, summaryInputTokens, summaryPrompt, transcript, withTimeout } from "./summary"
import { parseTodo, TODO_DESCRIPTION, TODO_INPUT, TODO_TOOL, todoSummary } from "./todo"
import { estimateTokens } from "./tokens"

type Feature = "T2" | "T3" | "T4" | "T5" | "T6"
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

    // T1: what the agent reads and changes. T4 counts the calls; T6 remembers how each file looked.
    registrations.push(
      await ctx.tool.hook("execute.after", async (event) => {
        const state = await store.get(event.sessionID)
        state.toolStreak++
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

    // T3: a fuller summary than OpenCode's own. Any failure leaves `result` unset, so OpenCode's summary runs.
    registrations.push(
      await ctx.session.hook("compaction", async (event) => {
        const state = await store.get(event.sessionID)
        state.compactedTokens = estimateTokens(JSON.stringify(event.messages.map((message) => (message as { content?: unknown }).content)))
        store.save(event.sessionID)
        if (!on("T3") || event.result) return
        const { previous, text } = transcript(event.messages, summaryInputTokens(await contextWindow(event.model)))
        if (!text.trim() && !previous) return
        const prompt = summaryPrompt({ previous, todo: state.todo, conversation: text })
        const started = Date.now()
        const reply = await withTimeout(
          ctx.generate.text({ prompt, model: event.model }).catch((error: unknown) => {
            trace({ sessionID: event.sessionID, feature: "T3", event: "error", error: String(error) })
            return undefined
          }),
        )
        const summary = reply?.text.trim()
        if (!summary || !looksLikeCheckpoint(summary)) {
          trace({ sessionID: event.sessionID, feature: "T3", event: "fallback", ms: Date.now() - started, empty: !summary })
          return
        }
        event.result = { summary, tokens: estimateUsage(prompt, summary) }
        trace({
          sessionID: event.sessionID,
          feature: "T3",
          event: "summary",
          ms: Date.now() - started,
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(summary),
        })
      }),
    )

    // T2, T6, T4: additions to each request. None of them is saved in the session.
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        const state = await store.get(event.sessionID)
        const messages = event.messages as Message[]
        let changed = false
        if (on("T2")) {
          const index = checkpointIndex(messages)
          const checkpoint = messages[index]
          if (checkpoint) {
            const snapshot = await ensureSnapshot(event.sessionID, summaryFromCheckpoint(textOf(checkpoint)), event.model)
            const message = snapshot?.text ? userMessage(messages, snapshot.text) : undefined
            if (message) messages.splice(index + 1, 0, message)
          }
        }
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

    // T5: the todo tool, unless another plugin already provides one.
    if (on("T5")) {
      registrations.push(
        await ctx.tool.transform((editor) => {
          if (editor.get(TODO_TOOL) || editor.list().some((tool) => tool.name === TODO_TOOL)) return
          editor.add({
            name: TODO_TOOL,
            description: TODO_DESCRIPTION,
            input: TODO_INPUT,
            execute: async (input, context) => {
              const items = parseTodo(input)
              const state = await store.get(context.sessionID)
              state.todo = items
              store.save(context.sessionID)
              trace({ sessionID: context.sessionID, feature: "T5", items: items.length })
              return { content: todoSummary(items) }
            },
          })
        }),
      )
    }

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
