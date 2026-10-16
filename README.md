# opencode-lodestar

Keeps [OpenCode](https://opencode.ai) on track through compaction.

When a long session fills the context window, OpenCode replaces the conversation with a summary. Work that lived only in the conversation, like the files the agent was editing and the plan it was following, can get lost. lodestar puts that work back after compaction and writes fuller summaries, so the agent picks up where it left off.

> **Status:** in development. It isn't ready to install yet.

## Development

You need [Bun](https://bun.sh).

```sh
git clone https://github.com/dhkimxx/opencode-lodestar
cd opencode-lodestar
bun install
bun run check
```

`bun run check` type-checks the code, runs the tests, and builds `dist/index.js`.

`dist/` is committed on purpose. GitHub installs don't run a build step, so they need the built JavaScript. Run `bun run bundle` and commit `dist/` with your change. CI fails if `dist/` is out of date.

Don't add `build`, `prepare`, `prepack`, or install scripts to `package.json`. npm runs an extra install step for GitHub packages that have them, and that step fails inside OpenCode.

The evaluation harness is described in [eval/README.md](eval/README.md). Releases are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
