// OpenCode provides these modules at runtime. A plugin that bundles its own copy fails to load.
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) console.log(output.path)

// Top-level await needs this file to be a module.
export {}
