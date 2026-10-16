// @bun
// src/index.ts
import { appendFile } from "fs/promises";
import { Plugin } from "@opencode/plugin";

// src/files.ts
import { readFile, stat } from "fs/promises";
import path from "path";
var EDIT_TOOLS = new Set(["edit", "write", "multiedit"]);
var MAX_RECORDS = 200;
async function diskState(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined;
  } catch {
    return;
  }
}
async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return;
  }
}
var lastUsed = (record) => Math.max(record.readAt ?? 0, record.editedAt ?? 0);
function touchedFiles(tool, input, output, directory) {
  const resolve = (value) => typeof value === "string" && value ? path.resolve(directory, value) : undefined;
  const fields = input ?? {};
  const file = resolve(fields.path ?? fields.filePath);
  if (tool === "read" && file)
    return { read: [file], edited: [] };
  if (EDIT_TOOLS.has(tool) && file)
    return { read: [], edited: [file] };
  if (tool === "patch") {
    const applied = (output ?? {}).applied ?? [];
    const edited = applied.flatMap((item) => {
      const target = item.type === "delete" ? undefined : resolve(item.target);
      return target ? [target] : [];
    });
    return { read: [], edited };
  }
  return { read: [], edited: [] };
}
async function recordTool(state, input) {
  const touched = touchedFiles(input.tool, input.input, input.output, input.directory);
  for (const [files, field] of [
    [touched.read, "readAt"],
    [touched.edited, "editedAt"]
  ]) {
    for (const file of files) {
      const record = state.files[file] ??= { path: file };
      record[field] = input.now;
      record.seen = await diskState(file);
      record.reported = undefined;
    }
  }
  const records = Object.values(state.files);
  if (records.length > MAX_RECORDS) {
    for (const record of records.sort((a, b) => lastUsed(a) - lastUsed(b)).slice(0, records.length - MAX_RECORDS)) {
      delete state.files[record.path];
    }
  }
  return touched.read.length + touched.edited.length > 0;
}

// src/limits.ts
var RESTORE_FILES = 5;
var RESTORE_FILE_TOKENS = 5000;
var RESTORE_SKILL_TOKENS = 5000;
var RESTORE_SKILLS_TOTAL = 25000;
var RESTORE_PLAN_TOKENS = 5000;
var RESTORE_SHARE = 0.2;
var RESTORE_MIN_TOKENS = 1e4;
var RESTORE_MAX_TOKENS = 40000;
var SUMMARY_TIMEOUT_MS = 120000;
var SUMMARY_INPUT_SHARE = 0.5;
var SUMMARY_MAX_INPUT_TOKENS = 1e5;
var RECITE_AFTER_TOOL_CALLS = 8;
var STALE_CHECK_FILES = 50;
var PROGRESS_NOTES = 3;
var PROGRESS_NOTE_CHARS = 600;

// src/messages.ts
var CHECKPOINT = "<conversation-checkpoint>";
function parts(message) {
  const content = message.content;
  if (typeof content === "string")
    return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}
function textOf(message) {
  return parts(message).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(`
`);
}
function checkpointIndex(messages) {
  return messages.findLastIndex((message) => message.role === "user" && textOf(message).startsWith(CHECKPOINT));
}
var isCheckpoint = (message) => message.role === "user" && textOf(message).startsWith(CHECKPOINT);
function userMessage(messages, text) {
  const host = messages[0]?.constructor;
  if (typeof host?.user !== "function")
    return;
  return host.user(text);
}
function insertNearEnd(messages, message) {
  const at = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
  messages.splice(at, 0, message);
}

// src/reminders.ts
import path2 from "path";
function recitation(state) {
  if (state.toolStreak < RECITE_AFTER_TOOL_CALLS || state.recited)
    return;
  return `<lodestar-reminder>You have made ${state.toolStreak} tool calls since you last wrote to the user. Before your next tool call, write one or two sentences: what is done so far, and what you will do next.</lodestar-reminder>`;
}
async function staleFiles(state) {
  const records = Object.values(state.files).filter((record) => record.seen).sort((a, b) => lastUsed(b) - lastUsed(a)).slice(0, STALE_CHECK_FILES);
  const changed = [];
  const deleted = [];
  for (const record of records) {
    const seen = record.seen;
    if (!seen)
      continue;
    const now = await diskState(record.path);
    if (!now) {
      if (record.reported !== "deleted") {
        deleted.push(record.path);
        record.reported = "deleted";
      }
      continue;
    }
    if (now.mtimeMs === seen.mtimeMs && now.size === seen.size)
      continue;
    const reported = record.reported;
    if (reported && reported !== "deleted" && reported.mtimeMs === now.mtimeMs && reported.size === now.size)
      continue;
    changed.push(record.path);
    record.reported = now;
  }
  return { changed, deleted };
}
function staleNotice(state, files) {
  if (files.changed.length === 0 && files.deleted.length === 0)
    return;
  const relative = (file) => state.directory ? path2.relative(state.directory, file) || file : file;
  const lines = [
    ...files.changed.length > 0 ? [`These files changed on disk after you last read or edited them: ${files.changed.map(relative).join(", ")}. Read them again before you edit them.`] : [],
    ...files.deleted.length > 0 ? [`These files were deleted: ${files.deleted.map(relative).join(", ")}.`] : []
  ];
  return `<lodestar-reminder>${lines.join(" ")}</lodestar-reminder>`;
}

// src/restore.ts
import { createHash } from "crypto";
import { homedir } from "os";
import path3 from "path";

// src/tokens.ts
var estimateTokens = (text) => Math.ceil(text.length / 4);
function keepStart(text, tokens) {
  const limit = tokens * 4;
  return text.length <= limit ? text : `${text.slice(0, limit)}
[\u2026 cut to about ${tokens} tokens]`;
}

// src/restore.ts
var PLAN_DIR = path3.join(homedir(), ".opencode", "plan");
function restoreBudget(compactedTokens, window) {
  const fromConversation = Math.max(RESTORE_MIN_TOKENS, RESTORE_SHARE * (compactedTokens ?? 0));
  return Math.floor(Math.min(RESTORE_MAX_TOKENS, RESTORE_SHARE * window, fromConversation));
}
var numbered = (text) => text.split(`
`).map((line, index) => `${index + 1}: ${line}`).join(`
`);
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}
${text}
${fence}`;
}
async function buildRestoration(state, window, summaryKey) {
  let budget = restoreBudget(state.compactedTokens, window);
  const sections = [];
  const take = (text) => {
    const tokens = estimateTokens(text);
    if (tokens > budget)
      return false;
    budget -= tokens;
    sections.push(text);
    return true;
  };
  const relative = (file) => state.directory ? path3.relative(state.directory, file) || file : file;
  if (state.notes.length > 0)
    take(`## Your latest progress notes

${state.notes.map((note) => `- ${note}`).join(`
`)}`);
  const records = Object.values(state.files);
  const planRecord = records.filter((record) => record.editedAt && record.path.startsWith(PLAN_DIR + path3.sep)).sort((a, b) => lastUsed(b) - lastUsed(a))[0];
  const planText = planRecord && await readText(planRecord.path);
  const plan = !!planText && take(`## Plan (${planRecord.path})

${keepStart(planText, RESTORE_PLAN_TOKENS)}`);
  const candidates = await Promise.all(records.filter((record) => !record.path.startsWith(PLAN_DIR + path3.sep)).map(async (record) => ({ record, disk: await diskState(record.path) })));
  const recent = candidates.flatMap((candidate) => candidate.disk ? [{ ...candidate, disk: candidate.disk }] : []).sort((a, b) => b.disk.mtimeMs - a.disk.mtimeMs || lastUsed(b.record) - lastUsed(a.record)).slice(0, RESTORE_FILES);
  const fileSections = [];
  let files = 0;
  let references = 0;
  for (const { record } of recent) {
    const text = await readText(record.path);
    if (text === undefined)
      continue;
    const content = numbered(text);
    const tokens = estimateTokens(content);
    const full = `### ${relative(record.path)}

${fenced(content)}`;
    if (tokens <= RESTORE_FILE_TOKENS && estimateTokens(full) <= budget) {
      budget -= estimateTokens(full);
      fileSections.push(full);
      files++;
      continue;
    }
    const reference = `### ${relative(record.path)}

Not restored: about ${tokens} tokens, too large. Read it again if you need it.`;
    if (estimateTokens(reference) <= budget) {
      budget -= estimateTokens(reference);
      fileSections.push(reference);
      references++;
    }
  }
  if (fileSections.length > 0) {
    sections.push(`## Files you were working with

Current contents, with line numbers.

${fileSections.join(`

`)}`);
  }
  const skillSections = [];
  let skillBudget = RESTORE_SKILLS_TOTAL;
  for (const skill of Object.values(state.skills).sort((a, b) => b.at - a.at)) {
    const body = `### Skill: ${skill.name}

${keepStart(skill.text, RESTORE_SKILL_TOKENS)}`;
    const tokens = estimateTokens(body);
    if (tokens > skillBudget || tokens > budget)
      break;
    skillBudget -= tokens;
    budget -= tokens;
    skillSections.push(body);
  }
  if (skillSections.length > 0) {
    sections.push(`## Skills you loaded earlier

Their instructions still apply. You already ran them for the request that loaded them, so don't run them again for that request.

${skillSections.join(`

`)}`);
  }
  if (sections.length === 0)
    return;
  const text = [
    "<restored-context>",
    "The conversation was compacted. lodestar read the working context below fresh from disk right after the compaction. Use it instead of reading these files again, unless they may have changed since.",
    "",
    sections.join(`

`),
    "</restored-context>"
  ].join(`
`);
  return {
    text,
    tokens: estimateTokens(text),
    at: Date.now(),
    summaryKey,
    files,
    references,
    skills: skillSections.length,
    plan
  };
}
function describeRestoration(restoration) {
  const parts = [
    restoration.files > 0 ? `${restoration.files} file${restoration.files === 1 ? "" : "s"}` : undefined,
    restoration.plan ? "the plan" : undefined,
    restoration.skills > 0 ? `${restoration.skills} skill${restoration.skills === 1 ? "" : "s"}` : undefined
  ].filter(Boolean);
  const what = parts.length > 0 ? parts.join(", ") : "progress notes";
  return `lodestar restored ${what} after compaction (~${Math.max(1, Math.round(restoration.tokens / 1000))}k tokens).`;
}
var summaryKeyOf = (summary) => createHash("sha256").update(summary.trim()).digest("hex");
function summaryFromCheckpoint(text) {
  const match = text.match(/<summary>\n([\s\S]*?)\n<\/summary>/);
  return match?.[1] ?? text;
}

// src/state.ts
var empty = () => ({ files: {}, notes: [], skills: {}, toolStreak: 0, recited: false });

class Store {
  storage;
  cache = new Map;
  loading = new Map;
  pending = new Map;
  constructor(storage) {
    this.storage = storage;
  }
  key(sessionID) {
    return `session/${sessionID}`;
  }
  async get(sessionID) {
    const cached = this.cache.get(sessionID);
    if (cached)
      return cached;
    let loading = this.loading.get(sessionID);
    if (!loading) {
      loading = this.storage.get(this.key(sessionID)).catch(() => {
        return;
      }).then((value) => {
        const state = { ...empty(), ...value ?? {} };
        this.cache.set(sessionID, state);
        this.loading.delete(sessionID);
        return state;
      });
      this.loading.set(sessionID, loading);
    }
    return loading;
  }
  save(sessionID) {
    clearTimeout(this.pending.get(sessionID));
    this.pending.set(sessionID, setTimeout(() => {
      this.pending.delete(sessionID);
      const state = this.cache.get(sessionID);
      if (state)
        this.storage.set(this.key(sessionID), JSON.parse(JSON.stringify(state))).catch(() => {});
    }, 200));
  }
  async remove(sessionID) {
    clearTimeout(this.pending.get(sessionID));
    this.pending.delete(sessionID);
    this.cache.delete(sessionID);
    await this.storage.remove(this.key(sessionID)).catch(() => {});
  }
}

// src/summary.ts
var SECTIONS = [
  "## User requests",
  "Every request the user made, in order, each marked done, in progress, or not started. Quote the user's own words for any request that isn't done.",
  "## Rules from the user",
  "Every rule, constraint, and preference the user stated, word for word: what to do, what never to do, and which files or areas are off limits. Keep all of them, even ones that seem minor or were stated long ago.",
  "## Key facts",
  "Facts the work depends on: how the code is organized, the conventions it follows, and decisions made, with their reasons.",
  "## Files",
  "Each file read or changed, with what matters about it. Include short code excerpts wherever later work has to match exact names, signatures, or values.",
  "## Errors and fixes",
  "Each error, quoted exactly, and what fixed it. Also what was tried and didn't work, so it isn't tried again.",
  "## Plan and progress",
  "The plan or task list, if there is one, with the status of every item.",
  "## Current work",
  "What was being done right before this checkpoint, in detail.",
  "## Next step",
  "The next step, as it follows from the user's latest request. Don't invent new work."
];
var HEADINGS = SECTIONS.filter((line) => line.startsWith("## "));
var clip = (text, chars) => text.length <= chars ? text : `${text.slice(0, chars)}
[\u2026 ${text.length - chars} more characters]`;
function resultText(part) {
  const result = part.result;
  if (!result)
    return "";
  if (result.type === "text" && typeof result.value === "string")
    return result.value;
  if (result.type === "error")
    return `Error: ${typeof result.value === "string" ? result.value : JSON.stringify(result.value)}`;
  if (result.type === "content" && Array.isArray(result.value)) {
    return result.value.map((item) => item.type === "text" ? item.text ?? "" : `[${item.type}]`).join(`
`);
  }
  return JSON.stringify(result.value) ?? "";
}
function transcript(messages, maxTokens) {
  let previous;
  const entries = [];
  for (const message of messages) {
    if (isCheckpoint(message)) {
      previous = textOf(message);
      continue;
    }
    for (const part of parts(message)) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        const limit = message.role === "user" ? entries.length === 0 ? 20000 : 12000 : 4000;
        entries.push({ text: `[${message.role}]
${clip(part.text, limit)}` });
      } else if (part.type === "tool-call") {
        entries.push({ text: `[tool call: ${String(part.name)}] ${clip(JSON.stringify(part.input) ?? "", 1500)}` });
      } else if (part.type === "tool-result") {
        entries.push({ text: "", label: `[tool result: ${String(part.name)}]`, output: resultText(part) });
      }
    }
  }
  const results = entries.filter((entry) => entry.output !== undefined);
  results.forEach((entry, index) => {
    const limit = index >= results.length - 30 ? 4000 : 600;
    entry.text = `${entry.label}
${clip(entry.output ?? "", limit)}`;
  });
  const limit = maxTokens * 4;
  const size = () => entries.reduce((sum, entry) => sum + entry.text.length + 2, 0);
  if (size() > limit)
    for (const entry of results)
      entry.text = `${entry.label}
${clip(entry.output ?? "", 200)}`;
  while (size() > limit && entries.length > 2)
    entries.splice(1, 1);
  return { previous, text: entries.map((entry) => entry.text).join(`

`) };
}
function summaryPrompt(input) {
  return [
    "You are writing the checkpoint for a coding session. The conversation below will be removed, and the agent will continue from this checkpoint, the most recent messages, and fresh copies of the files it was working with. Anything you leave out is lost.",
    "",
    "Write Markdown with exactly these sections, in this order:",
    "",
    SECTIONS.join(`
`),
    "",
    "Write facts, not commentary. Stay under 2,000 words. Don't call tools. Reply with the checkpoint only.",
    ...input.previous ? ["", "Carry everything that still matters from the previous checkpoint into the new one.", "<previous-checkpoint>", input.previous, "</previous-checkpoint>"] : [],
    "",
    "<conversation>",
    input.conversation,
    "</conversation>"
  ].join(`
`);
}
var looksLikeCheckpoint = (text) => HEADINGS.filter((heading) => text.includes(heading)).length >= 5;
function summaryInputTokens(window) {
  return Math.floor(Math.min(SUMMARY_MAX_INPUT_TOKENS, SUMMARY_INPUT_SHARE * window));
}
async function withTimeout(promise, ms = SUMMARY_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
var estimateUsage = (prompt, reply) => ({
  input: estimateTokens(prompt),
  output: estimateTokens(reply),
  reasoning: 0,
  cache: { read: 0, write: 0 }
});

// src/index.ts
var DEFAULT_WINDOW = 200000;
var src_default = Plugin.define({
  id: "opencode-lodestar",
  async setup(ctx) {
    const disabled = new Set((process.env.LODESTAR_DISABLE ?? "").split(",").map((name) => name.trim().toUpperCase()));
    const on = (feature) => !disabled.has(feature);
    const tracePath = process.env.LODESTAR_TRACE;
    const trace = (entry) => {
      if (tracePath)
        appendFile(tracePath, `${JSON.stringify({ at: Date.now(), ...entry })}
`).catch(() => {});
    };
    const store = new Store(ctx.storage);
    const registrations = [];
    const windows = new Map;
    async function contextWindow(model) {
      if (!model)
        return DEFAULT_WINDOW;
      const key = `${model.providerID}/${model.id}`;
      const known = windows.get(key);
      if (known)
        return known;
      try {
        const result = await ctx.model.list();
        const models = Array.isArray(result) ? result : result.data ?? [];
        const info = models.find((candidate) => candidate.providerID === model.providerID && (candidate.modelID ?? candidate.id) === model.id);
        const window = info?.limit?.context ?? DEFAULT_WINDOW;
        windows.set(key, window);
        return window;
      } catch {
        return DEFAULT_WINDOW;
      }
    }
    async function directoryOf(sessionID, state) {
      if (!state.directory) {
        try {
          const info = await ctx.session.get({ sessionID });
          state.directory = info.location?.directory;
        } catch {}
      }
      return state.directory ?? process.cwd();
    }
    const building = new Map;
    function ensureSnapshot(sessionID, summary, model) {
      const running = building.get(sessionID);
      if (running)
        return running;
      const job = (async () => {
        const state = await store.get(sessionID);
        const key = summaryKeyOf(summary);
        if (state.snapshot?.summaryKey === key)
          return state.snapshot;
        await directoryOf(sessionID, state);
        const restoration = await buildRestoration(state, await contextWindow(model), key);
        state.snapshot = restoration ? { text: restoration.text, tokens: restoration.tokens, at: restoration.at, summaryKey: key, note: describeRestoration(restoration) } : { text: "", tokens: 0, at: Date.now(), summaryKey: key };
        store.save(sessionID);
        trace({ sessionID, feature: "T2", event: "snapshot", tokens: state.snapshot.tokens, note: state.snapshot.note });
        return state.snapshot;
      })().finally(() => building.delete(sessionID));
      building.set(sessionID, job);
      return job;
    }
    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      const state = await store.get(event.sessionID);
      state.toolStreak++;
      if (event.status === "completed") {
        await recordTool(state, {
          tool: event.tool,
          input: event.input,
          output: event.result.output,
          directory: await directoryOf(event.sessionID, state),
          now: Date.now()
        });
      }
      store.save(event.sessionID);
    }));
    registrations.push(await ctx.session.hook("compaction", async (event) => {
      const state = await store.get(event.sessionID);
      state.compactedTokens = estimateTokens(JSON.stringify(event.messages.map((message) => message.content)));
      store.save(event.sessionID);
      if (!on("T3") || event.result)
        return;
      const { previous, text } = transcript(event.messages, summaryInputTokens(await contextWindow(event.model)));
      if (!text.trim() && !previous)
        return;
      const prompt = summaryPrompt({ previous, conversation: text });
      const started = Date.now();
      const reply = await withTimeout(ctx.generate.text({ prompt, model: event.model }).catch((error) => {
        trace({ sessionID: event.sessionID, feature: "T3", event: "error", error: String(error) });
        return;
      }));
      const summary = reply?.text.trim();
      if (!summary || !looksLikeCheckpoint(summary)) {
        trace({ sessionID: event.sessionID, feature: "T3", event: "fallback", ms: Date.now() - started, empty: !summary });
        return;
      }
      event.result = { summary, tokens: estimateUsage(prompt, summary) };
      trace({
        sessionID: event.sessionID,
        feature: "T3",
        event: "summary",
        ms: Date.now() - started,
        inputTokens: estimateTokens(prompt),
        outputTokens: estimateTokens(summary)
      });
    }));
    registrations.push(await ctx.session.hook("context", async (event) => {
      const state = await store.get(event.sessionID);
      const messages = event.messages;
      let changed = false;
      if (on("T2")) {
        const index = checkpointIndex(messages);
        const checkpoint = messages[index];
        if (checkpoint) {
          const snapshot = await ensureSnapshot(event.sessionID, summaryFromCheckpoint(textOf(checkpoint)), event.model);
          const message = snapshot?.text ? userMessage(messages, snapshot.text) : undefined;
          if (message)
            messages.splice(index + 1, 0, message);
        }
      }
      if (on("T6")) {
        const files = await staleFiles(state);
        const notice = staleNotice(state, files);
        const message = notice ? userMessage(messages, notice) : undefined;
        if (files.changed.length + files.deleted.length > 0)
          changed = true;
        if (message) {
          insertNearEnd(messages, message);
          trace({ sessionID: event.sessionID, feature: "T6", changed: files.changed, deleted: files.deleted });
        }
      }
      if (on("T4")) {
        const reminder = recitation(state);
        const message = reminder ? userMessage(messages, reminder) : undefined;
        if (message) {
          insertNearEnd(messages, message);
          state.recited = true;
          changed = true;
          trace({ sessionID: event.sessionID, feature: "T4", toolStreak: state.toolStreak });
        }
      }
      if (changed)
        store.save(event.sessionID);
    }));
    const abort = new AbortController;
    async function handle(event) {
      const data = event.data ?? {};
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      if (!sessionID)
        return;
      if (event.type === "session.deleted")
        return store.remove(sessionID);
      const state = await store.get(sessionID);
      if (event.type === "session.text.ended" && typeof data.text === "string" && data.text.trim()) {
        if (state.toolStreak > 0) {
          const note = data.text.trim().replace(/\s+/g, " ");
          state.notes = [...state.notes, note.length > PROGRESS_NOTE_CHARS ? `${note.slice(0, PROGRESS_NOTE_CHARS)}\u2026` : note].slice(-PROGRESS_NOTES);
        }
        state.toolStreak = 0;
        state.recited = false;
        store.save(sessionID);
      }
      if (event.type === "session.skill.activated" && typeof data.name === "string" && typeof data.text === "string") {
        state.skills[data.name] = { name: data.name, text: data.text, at: Date.now() };
        store.save(sessionID);
      }
      if (event.type === "session.compaction.ended" && on("T2") && typeof data.text === "string") {
        await ensureSnapshot(sessionID, data.text, data.model);
      }
    }
    (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            await handle(event).catch(() => {});
          }
        } catch {}
        if (!abort.signal.aborted)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    return async () => {
      abort.abort();
      for (const registration of registrations)
        await registration.dispose();
    };
  }
});
export {
  src_default as default
};
