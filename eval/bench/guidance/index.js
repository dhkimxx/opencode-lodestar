// A prototype for the benchmark, not a release: the working rules that Codex's instructions give gpt-6-luna for
// searching and reading, worded for OpenCode's tools. They are added to the system prompt of every request.
const GUIDANCE = `# Working efficiently

- When you search for text or files, reach first for \`rg\` or \`rg --files\` in the shell. It is much faster than grep or find.
- Batch independent searches and reads: make all independent tool calls in the same turn instead of one per turn, and inspect every result. Keep dependent steps, edits, and follow-ups that depend on earlier output sequential.
- Avoid unnecessary output.`

export default {
  id: "bench-guidance",
  async setup(ctx) {
    const registration = await ctx.session.hook("context", async (event) => {
      if (!event.system.some((part) => part.text === GUIDANCE)) event.system.push({ type: "text", text: GUIDANCE })
    })
    return () => registration.dispose()
  },
}
