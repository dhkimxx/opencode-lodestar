// @bun
// src/index.ts
import { appendFile } from "fs/promises";
import { Plugin } from "@opencode/plugin";

// src/files.ts
import { readFile, stat } from "fs/promises";
import path from "path";

// src/limits.ts
var RESTORE_TASK_TOKENS = 3000;
var RESTORE_REQUESTS = 3;
var RESTORE_REQUEST_TOKENS = 1000;
var REQUEST_CHARS = 16000;
var CALLS_KEPT = 5;
var TEST_TAIL_LINES = 20;
var TEST_TAIL_CHARS = 2000;
var RESTORE_DIFF_TOKENS = 3000;
var RESTORE_DIFF_CONTEXT = 10;
var RESTORE_STATUS_LINES = 20;
var RESTORE_READ_FILES = 3;
var RESTORE_READ_TOKENS = 1200;
var RANGES_KEPT = 4;
var RESTORE_LINE_CHARS = 1000;
var RESTORE_FILES = 5;
var RESTORE_OTHER_FILES = 30;
var RESTORE_FILE_TOKENS = 5000;
var RESTORE_NEW_FILE_TOKENS = 1500;
var RESTORE_SKILL_TOKENS = 5000;
var RESTORE_SKILLS_TOTAL = 25000;
var RESTORE_PLAN_TOKENS = 5000;
var RESTORE_SHARE = 0.2;
var RESTORE_MIN_TOKENS = 1e4;
var RESTORE_MAX_TOKENS = 40000;
var RECITE_AFTER_TOOL_CALLS = 8;
var STALE_CHECK_FILES = 50;
var SHELL_RUNS_KEPT = 20;
var SHELL_RUN_SLACK_MS = 2000;
var PROGRESS_NOTES = 3;
var PROGRESS_NOTE_CHARS = 600;

// src/files.ts
var EDIT_TOOLS = new Set(["edit", "write", "multiedit"]);
var SHELL_TOOLS = new Set(["shell", "bash"]);
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
function contentText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join(`
`);
}
function readRange(content) {
  const match = contentText(content).match(/^Read file .*, lines (\d+)-(\d+)/m);
  if (!match)
    return;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start >= 1 && end >= start ? [start, end] : undefined;
}
function addRange(ranges, range) {
  let [start, end] = range;
  const rest = [];
  for (const [from, to] of ranges ?? []) {
    if (from <= end + 1 && to >= start - 1) {
      start = Math.min(start, from);
      end = Math.max(end, to);
    } else
      rest.push([from, to]);
  }
  return [...rest, [start, end]].slice(-RANGES_KEPT);
}
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
function recordShellRun(state, start, end) {
  state.shellRuns = [...state.shellRuns ?? [], { start, end }].slice(-SHELL_RUNS_KEPT);
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
      const range = field === "readAt" ? readRange(input.content) : undefined;
      if (range)
        record.ranges = addRange(record.ranges, range);
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
  return `<lodestar-reminder>You have made ${state.toolStreak} tool calls since you last wrote to the user. Before your next tool call, write one or two sentences: what is done so far, and what you will do next. Then carry on in the same response.</lodestar-reminder>`;
}
var duringShell = (state, time) => (state.shellRuns ?? []).some((run) => time >= run.start - SHELL_RUN_SLACK_MS && time <= run.end + SHELL_RUN_SLACK_MS);
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
        if (!(state.shellRuns ?? []).some((run) => run.end >= lastUsed(record)))
          deleted.push(record.path);
        record.reported = "deleted";
      }
      continue;
    }
    if (now.mtimeMs === seen.mtimeMs && now.size === seen.size)
      continue;
    if (duringShell(state, now.mtimeMs)) {
      record.seen = now;
      continue;
    }
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
import path4 from "path";

// src/changes.ts
import { execFile } from "child_process";
import { realpath } from "fs/promises";
import path3 from "path";
var GIT_TIMEOUT_MS = 5000;
function git(directory, args) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
    }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}
async function inside(root, file) {
  const real = await realpath(file).catch(() => realpath(path3.dirname(file)).then((directory) => path3.join(directory, path3.basename(file)), () => {
    return;
  }));
  if (!real)
    return;
  const relative = path3.relative(root, real);
  return relative && !relative.startsWith("..") && !path3.isAbsolute(relative) ? relative : undefined;
}
async function changesOf(directory, files, context) {
  const top = (await git(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top)
    return;
  const root = await realpath(top).catch(() => top);
  const located = await Promise.all(files.map(async (file) => ({ file, relative: await inside(root, file) })));
  const tracked = new Map(located.flatMap(({ file, relative }) => relative ? [[relative, file]] : []));
  const outside = located.filter(({ relative }) => !relative).map(({ file }) => file);
  const specs = [...tracked.keys()].map((relative) => `:(literal)${relative}`);
  const diffs = new Map;
  const untracked = [];
  if (specs.length > 0) {
    const hasHead = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]) !== undefined;
    const diff = await git(root, [
      "diff",
      ...hasHead ? ["HEAD"] : [],
      `-U${context}`,
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...specs
    ]);
    for (const chunk of (diff ?? "").split(/^(?=diff --git )/m)) {
      const name = chunk.match(/^\+\+\+ b\/(.*)$/m)?.[1] ?? chunk.match(/^--- a\/(.*)$/m)?.[1];
      const file = name === undefined ? undefined : tracked.get(name);
      if (file && chunk.trim())
        diffs.set(file, chunk.trimEnd());
    }
    const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs]);
    for (const relative of (others ?? "").split("\x00").filter(Boolean)) {
      const file = tracked.get(relative);
      if (file)
        untracked.push(file);
    }
    const ignored = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...specs]);
    for (const relative of (ignored ?? "").split("\x00").filter(Boolean)) {
      const file = tracked.get(relative);
      if (file)
        outside.push(file);
    }
  }
  const status = (await git(root, ["status", "--short", "--untracked-files=normal"]) ?? "").split(`
`).filter(Boolean);
  return { root, diffs, untracked, outside, status };
}

// src/tokens.ts
var estimateTokens = (text) => Math.ceil(text.length / 4);
function keepStart(text, tokens) {
  const limit = tokens * 4;
  return text.length <= limit ? text : `${text.slice(0, limit)}
[\u2026 cut to about ${tokens} tokens]`;
}
function keepEnds(text, tokens) {
  const limit = tokens * 4;
  if (text.length <= limit)
    return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}
[\u2026 about ${estimateTokens(text.slice(half, -half))} tokens left out \u2026]
${text.slice(-half)}`;
}

// src/restore.ts
var PLAN_DIR = path4.join(homedir(), ".opencode", "plan");
function restoreBudget(compactedTokens, window) {
  const fromConversation = Math.max(RESTORE_MIN_TOKENS, RESTORE_SHARE * (compactedTokens ?? 0));
  return Math.floor(Math.min(RESTORE_MAX_TOKENS, RESTORE_SHARE * window, fromConversation));
}
var numbered = (lines, first = 1) => lines.map((line, index) => `${first + index}: ${line.length > RESTORE_LINE_CHARS ? `${line.slice(0, RESTORE_LINE_CHARS)}\u2026` : line}`).join(`
`);
var linesOf = (text) => (text.endsWith(`
`) ? text.slice(0, -1) : text).split(`
`);
function fenced(text, language = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}
${text}
${fence}`;
}
var normalize = (text) => text.replace(/\s+/g, " ").trim();
var isPlan = (record) => record.path.startsWith(PLAN_DIR + path4.sep);
async function buildRestoration(state, window, summaryKey, visible = "") {
  let budget = restoreBudget(state.compactedTokens, window);
  const sections = [];
  const sizes = {};
  const take = (name, text) => {
    const tokens = estimateTokens(text);
    if (tokens > budget)
      return false;
    budget -= tokens;
    sections.push(text);
    sizes[name] = tokens;
    return true;
  };
  const relative = (file) => state.directory ? path4.relative(state.directory, file) || file : file;
  const shown = new Set;
  const present = normalize(visible);
  const [first, ...later] = state.requests ?? [];
  const parts = [];
  if (first && !present.includes(normalize(first))) {
    parts.push(`The user's request, word for word. Where the summary leaves out a detail, it is here.

${fenced(keepEnds(first, RESTORE_TASK_TOKENS))}`);
  }
  const missing = later.filter((request) => !present.includes(normalize(request)));
  if (missing.length > 0) {
    parts.push(`${parts.length > 0 ? "The user's later messages" : "The user's latest messages"}, oldest first:

${missing.map((request) => fenced(keepEnds(request, RESTORE_REQUEST_TOKENS))).join(`

`)}`);
  }
  if (parts.length > 0)
    take("task", `## Your task

${parts.join(`

`)}`);
  const work = [];
  if (state.calls?.length) {
    work.push(`Your last tool calls, oldest first:

${state.calls.map((call) => `- ${call.what}${call.outcome ? `: ${call.outcome}` : ""}`).join(`
`)}`);
  }
  const test = state.lastTest;
  if (test) {
    const ending = test.exit === undefined ? "" : `, which ended with exit ${test.exit}`;
    work.push(`Your latest test run was \`${test.command}\`${ending}. The end of its output:

${fenced(test.tail || "(no output)")}`);
  }
  if (work.length > 0)
    take("state", `## Where you left off

${work.join(`

`)}`);
  const records = Object.values(state.files);
  const edited = records.filter((record) => record.editedAt && !isPlan(record)).sort((a, b) => (b.editedAt ?? 0) - (a.editedAt ?? 0));
  if (edited.length > 0) {
    const changes = await describeChanges(state, edited, relative, budget);
    if (changes && take("changes", changes.text))
      for (const file of changes.files)
        shown.add(file);
  }
  const reading = [];
  for (const record of records.filter((record) => !record.editedAt && record.ranges?.length && !isPlan(record)).sort((a, b) => lastUsed(b) - lastUsed(a))) {
    if (reading.length >= RESTORE_READ_FILES)
      break;
    const text = await readText(record.path);
    if (text === undefined)
      continue;
    const lines = linesOf(text);
    const chosen = [];
    let tokens = 0;
    for (const [start, end] of [...record.ranges ?? []].reverse()) {
      if (start > lines.length)
        continue;
      const size = estimateTokens(numbered(lines.slice(start - 1, Math.min(end, lines.length)), start));
      if (tokens + size > RESTORE_READ_TOKENS)
        break;
      tokens += size;
      chosen.push([start, Math.min(end, lines.length)]);
    }
    if (chosen.length === 0)
      continue;
    chosen.sort((a, b) => a[0] - b[0]);
    const label = chosen.map(([start, end]) => `${start}-${end}`).join(", ");
    const body = chosen.map(([start, end]) => fenced(numbered(lines.slice(start - 1, end), start))).join(`

`);
    reading.push(`### ${relative(record.path)}, lines ${label}

${body}`);
    shown.add(record.path);
  }
  if (reading.length > 0) {
    take("reading", `## Code you were reading

The parts of these files you read last, as they are on disk now, with line numbers.

${reading.join(`

`)}`);
  }
  if (state.notes.length > 0)
    take("notes", `## Your latest progress notes

${state.notes.map((note) => `- ${note}`).join(`
`)}`);
  const planRecord = records.filter((record) => record.editedAt && isPlan(record)).sort((a, b) => lastUsed(b) - lastUsed(a))[0];
  const planText = planRecord && await readText(planRecord.path);
  if (planRecord && planText)
    take("plan", `## Plan (${planRecord.path})

${keepStart(planText, RESTORE_PLAN_TOKENS)}`);
  const others = [];
  for (const record of records.filter((record) => !shown.has(record.path) && !isPlan(record)).sort((a, b) => lastUsed(b) - lastUsed(a))) {
    if (others.length >= RESTORE_OTHER_FILES)
      break;
    if (await diskState(record.path))
      others.push(`- ${relative(record.path)}`);
  }
  if (others.length > 0) {
    take("others", `## Other files you used earlier

Not restored. Read them again when your task touches them.

${others.join(`
`)}`);
  }
  const skillSections = [];
  let skillBudget = Math.min(RESTORE_SKILLS_TOTAL, budget);
  for (const skill of Object.values(state.skills).sort((a, b) => b.at - a.at)) {
    const body = `### Skill: ${skill.name}

${keepStart(skill.text, RESTORE_SKILL_TOKENS)}`;
    const tokens = estimateTokens(body);
    if (tokens > skillBudget)
      break;
    skillBudget -= tokens;
    skillSections.push(body);
  }
  if (skillSections.length > 0) {
    take("skills", `## Skills you loaded earlier

Their instructions still apply. You already ran them for the request that loaded them, so don't run them again for that request.

${skillSections.join(`

`)}`);
  }
  if (sections.length === 0)
    return;
  const text = [
    "<restored-context>",
    "The conversation was compacted. Carry on from where you left off; don't start the task over. The code and changes below were read from disk right after the compaction, so you don't need to read them again unless they change.",
    "This is only what you used recently, not the whole project. Before a change that may reach other files, such as a rename, search the code for every place it affects.",
    "",
    sections.join(`

`),
    ...edited.length > 0 ? ["", "Before you finish:", "- Check your changes against each point of the user's request.", "- Run the tests that cover your changes."] : [],
    "</restored-context>"
  ].join(`
`);
  return { text, tokens: estimateTokens(text), at: Date.now(), summaryKey, sections: sizes };
}
async function describeChanges(state, edited, relative, limit) {
  const directory = state.directory ?? process.cwd();
  const files = edited.map((record) => record.path);
  let context = RESTORE_DIFF_CONTEXT;
  let changes = await changesOf(directory, files, context);
  const diffTokens = (diffs) => estimateTokens([...diffs.values()].join(`
`));
  if (changes && diffTokens(changes.diffs) > RESTORE_DIFF_TOKENS) {
    context = 3;
    changes = await changesOf(directory, files, context) ?? changes;
  }
  const parts = [];
  const restored = [];
  let room = limit - 200;
  const diffBudget = Math.min(RESTORE_DIFF_TOKENS, room);
  let budget = diffBudget;
  if (changes) {
    const diffs = [];
    const left = [];
    for (const file of files) {
      const diff = changes.diffs.get(file);
      if (!diff)
        continue;
      if (estimateTokens(diff) <= budget) {
        budget -= estimateTokens(diff);
        diffs.push(diff);
        restored.push(file);
      } else
        left.push(file);
    }
    room -= diffBudget - budget;
    if (diffs.length > 0) {
      parts.push(`\`git diff HEAD\` of the files you edited, with ${context} lines of context:

${fenced(diffs.join(`
`), "diff")}`);
    }
    if (left.length > 0)
      parts.push(`Also changed, too large to show here: ${left.map(relative).join(", ")}. Run \`git diff\` on them if you need to.`);
    const created = [];
    for (const file of changes.untracked) {
      const text = await readText(file);
      if (text === undefined)
        continue;
      const content = numbered(linesOf(text));
      const tokens = estimateTokens(content);
      if (tokens <= RESTORE_NEW_FILE_TOKENS && tokens <= budget && tokens <= room) {
        budget -= tokens;
        room -= tokens;
        created.push(`### ${relative(file)}

${fenced(content)}`);
        restored.push(file);
      }
    }
    if (created.length > 0)
      parts.push(`New files you created, with line numbers:

${created.join(`

`)}`);
    if (changes.status.length > 0) {
      const lines = changes.status.slice(0, RESTORE_STATUS_LINES);
      const more = changes.status.length - lines.length;
      const status = `\`git status --short\`:

${fenced(lines.join(`
`) + (more > 0 ? `
\u2026 and ${more} more` : ""))}`;
      if (estimateTokens(status) <= room) {
        room -= estimateTokens(status);
        parts.push(status);
      }
    }
  }
  const whole = [];
  const undescribed = changes ? changes.outside : files;
  for (const file of undescribed.slice(0, RESTORE_FILES)) {
    const text = await readText(file);
    if (text === undefined)
      continue;
    const content = numbered(linesOf(text));
    const tokens = estimateTokens(content);
    if (tokens <= RESTORE_FILE_TOKENS && tokens <= room) {
      room -= tokens;
      whole.push(`### ${relative(file)}

${fenced(content)}`);
      restored.push(file);
    }
  }
  if (whole.length > 0)
    parts.push(`${changes ? "Other files you edited" : "Files you edited"}, as they are now, with line numbers:

${whole.join(`

`)}`);
  if (parts.length === 0)
    return;
  return { text: `## Your changes so far

${parts.join(`

`)}`, files: restored };
}
function describeRestoration(restoration) {
  const names = Object.keys(restoration.sections);
  return `lodestar restored ${names.length > 0 ? names.join(", ") : "nothing"} after compaction (~${Math.max(1, Math.round(restoration.tokens / 1000))}k tokens).`;
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

// src/work.ts
import path5 from "path";
var TEST_COMMAND = /(^|[\s;&|(/])(pytest|py\.test|tox|nox|jest|vitest|mocha|phpunit|rspec|ctest)\b|\b(go|cargo|dotnet|mix|swift|deno|bun) test\b|\b(npm|pnpm|yarn)( run)? test|\bmake (test|check)\b|\bunittest\b|\b(mvn|gradlew?)\b.*\btest\b/;
var isTestCommand = (command) => TEST_COMMAND.test(command);
function oneLine(text, chars) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > chars ? `${line.slice(0, chars)}\u2026` : line;
}
function tail(text) {
  const lines = text.replace(/\s+$/, "").split(`
`).slice(-TEST_TAIL_LINES).join(`
`);
  return lines.length > TEST_TAIL_CHARS ? `\u2026${lines.slice(-TEST_TAIL_CHARS)}` : lines;
}
function describeCall(tool, input, output, content, directory) {
  const fields = input ?? {};
  const relative = (file) => path5.relative(directory, path5.resolve(directory, file)) || file;
  if (typeof fields.command === "string")
    return `${tool} \`${oneLine(fields.command, 200)}\``;
  if (typeof fields.pattern === "string") {
    const where = typeof fields.path === "string" ? ` in ${relative(fields.path)}` : "";
    return `${tool} \`${oneLine(fields.pattern, 120)}\`${where}`;
  }
  const touched = touchedFiles(tool, input, output, directory);
  const files = [...touched.read, ...touched.edited];
  if (files.length > 0) {
    const range = tool === "read" ? readRange(content) : undefined;
    return `${tool} ${files.map(relative).join(", ")}${range ? `, lines ${range[0]}-${range[1]}` : ""}`;
  }
  const file = fields.path ?? fields.filePath;
  if (typeof file === "string")
    return `${tool} ${relative(file)}`;
  const first = Object.values(fields).find((value) => typeof value === "string");
  return typeof first === "string" ? `${tool} ${oneLine(first, 120)}` : tool;
}
function recordCall(state, call) {
  const fields = call.output ?? {};
  const exit = typeof fields.exit === "number" ? fields.exit : undefined;
  const outcome = call.error !== undefined ? `failed: ${oneLine(call.error, 200)}` : exit !== undefined ? `exit ${exit}` : undefined;
  const what = describeCall(call.tool, call.input, call.output, call.content, call.directory);
  state.calls = [...state.calls ?? [], { what, ...outcome ? { outcome } : {} }].slice(-CALLS_KEPT);
  const command = call.input?.command;
  if (SHELL_TOOLS.has(call.tool) && typeof command === "string" && isTestCommand(command)) {
    const output = call.error ?? (contentText(call.content) || String(call.output?.output ?? ""));
    state.lastTest = { command: oneLine(command, 300), ...exit !== undefined ? { exit } : {}, tail: tail(output) };
  }
}
function recordRequest(state, text) {
  const request = text.trim().slice(0, REQUEST_CHARS);
  if (!request)
    return;
  const requests = state.requests ?? [];
  if (requests.includes(request))
    return;
  const [first, ...later] = [...requests, request];
  state.requests = [first, ...later.slice(-RESTORE_REQUESTS)];
}

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
    function ensureSnapshot(sessionID, summary, visible, model) {
      const running = building.get(sessionID);
      if (running)
        return running;
      const job = (async () => {
        const state = await store.get(sessionID);
        const key = summaryKeyOf(summary);
        if (state.snapshot?.summaryKey === key)
          return state.snapshot;
        await directoryOf(sessionID, state);
        const restoration = await buildRestoration(state, await contextWindow(model), key, visible);
        state.snapshot = restoration ? { text: restoration.text, tokens: restoration.tokens, at: restoration.at, summaryKey: key, note: describeRestoration(restoration) } : { text: "", tokens: 0, at: Date.now(), summaryKey: key };
        store.save(sessionID);
        trace({ sessionID, feature: "T2", event: "snapshot", tokens: state.snapshot.tokens, note: state.snapshot.note, sections: restoration?.sections });
        return state.snapshot;
      })().finally(() => building.delete(sessionID));
      building.set(sessionID, job);
      return job;
    }
    async function restoreInto(sessionID, messages, model) {
      const index = checkpointIndex(messages);
      const checkpoint = messages[index];
      if (!checkpoint)
        return;
      const visible = messages.slice(index).map(textOf).join(`
`);
      const snapshot = await ensureSnapshot(sessionID, summaryFromCheckpoint(textOf(checkpoint)), visible, model);
      const message = snapshot?.text ? userMessage(messages, snapshot.text) : undefined;
      if (message)
        messages.splice(index + 1, 0, message);
    }
    const shellStarts = new Map;
    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      if (SHELL_TOOLS.has(event.tool))
        shellStarts.set(event.id, Date.now());
    }));
    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      const state = await store.get(event.sessionID);
      const directory = await directoryOf(event.sessionID, state);
      state.toolStreak++;
      if (SHELL_TOOLS.has(event.tool)) {
        const now = Date.now();
        recordShellRun(state, shellStarts.get(event.id) ?? now, now);
        shellStarts.delete(event.id);
      }
      if (event.status === "completed") {
        const { output, content } = event.result;
        await recordTool(state, { tool: event.tool, input: event.input, output, content, directory, now: Date.now() });
        recordCall(state, { tool: event.tool, input: event.input, output, content, directory });
      } else {
        recordCall(state, { tool: event.tool, input: event.input, error: event.error.message, directory });
      }
      store.save(event.sessionID);
    }));
    registrations.push(await ctx.session.hook("prompt", async (event) => {
      const state = await store.get(event.sessionID);
      recordRequest(state, event.prompt.text);
      store.save(event.sessionID);
    }));
    registrations.push(await ctx.session.hook("compaction", async (event) => {
      const state = await store.get(event.sessionID);
      const messages = event.messages;
      state.compactedTokens = estimateTokens(JSON.stringify(messages.map((message) => message.content)));
      store.save(event.sessionID);
      if (on("T2"))
        await restoreInto(event.sessionID, messages, event.model);
    }));
    registrations.push(await ctx.session.hook("context", async (event) => {
      const state = await store.get(event.sessionID);
      const messages = event.messages;
      let changed = false;
      if (on("T2"))
        await restoreInto(event.sessionID, messages, event.model);
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
