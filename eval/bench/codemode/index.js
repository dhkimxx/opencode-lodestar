// A prototype for the benchmark, not a release: moves OpenCode's own tools into its Code Mode, so the model scripts them
// through `execute` instead of calling them one by one, as Codex's model does with its `exec`. The guidance rules come
// along, reworded for `execute`. BENCH_CODEMODE_LOG names a file that records what the transform saw.
import { appendFileSync } from "node:fs"

const TOOLS = (process.env.BENCH_CODEMODE_TOOLS ?? "read,grep,glob,shell").split(",")
const GUIDANCE = `# Working efficiently

- Call tools through \`execute\`. Put independent searches and reads in one \`execute\` call and run them together with \`Promise.allSettled([...])\`, then inspect every result. Keep dependent steps, edits, and follow-ups that depend on earlier output sequential.
- When you search for text or files, reach first for \`rg\` or \`rg --files\` in the shell. It is much faster than grep or find.
- Avoid unnecessary output: filter and trim results in your code before returning them.`

const log = (entry) => {
  if (process.env.BENCH_CODEMODE_LOG) appendFileSync(process.env.BENCH_CODEMODE_LOG, JSON.stringify(entry) + "\n")
}

export default {
  id: "bench-codemode",
  async setup(ctx) {
    const transform = await ctx.tool.transform((editor) => {
      log({ saw: editor.list().map((tool) => ({ id: tool.id, options: tool.options ?? null })) })
      for (const id of TOOLS) editor.update(id, (tool) => void (tool.options = { ...tool.options, codemode: true }))
      log({ after: editor.list().map((tool) => ({ id: tool.id, options: tool.options ?? null })) })
    })
    const context = await ctx.session.hook("context", async (event) => {
      if (!event.system.some((part) => part.text === GUIDANCE)) event.system.push({ type: "text", text: GUIDANCE })
    })
    return async () => {
      await transform.dispose()
      await context.dispose()
    }
  },
}
