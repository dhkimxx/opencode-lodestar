# opencode-lodestar

Keeps [OpenCode](https://opencode.ai) on track through compaction.

When a long session fills the context window, OpenCode replaces the conversation with a summary. Work that lived only in the conversation, like the files the agent was editing and the plan it was following, gets lost, and the agent spends the next steps reading it all again. lodestar puts that work back right after compaction, so the agent picks up where it left off.

## Features

- **Puts the work back.** Right after a compaction, the agent gets fresh copies of the files it was working with (up to five), its plan, its latest progress notes, and the skills it had loaded.
- **Notices outside changes.** When a file the agent read changes on disk, through your editor, a formatter, or a teammate's pull, the agent is told before its next step.
- **Keeps long runs on track.** After eight tool calls in a row with no word to you, the agent is asked for a one-line recap of what is done and what comes next.
- **Nothing to configure.** The defaults come from evaluation, and there are no settings to tune.

## Requirements

OpenCode 2. Tested with OpenCode 2.0.27. OpenCode 1 is not supported.

## Install

```sh
opencode plugin add github:dhkimxx/opencode-lodestar
```

This installs the plugin and adds it to the `plugins` list in your `opencode.json`. If OpenCode is already running, restart it.

To install a specific release, add its tag:

```sh
opencode plugin add github:dhkimxx/opencode-lodestar#v0.1.0
```

Update or remove the plugin with the same name you installed it with:

```sh
opencode plugin update github:dhkimxx/opencode-lodestar
opencode plugin remove github:dhkimxx/opencode-lodestar
```

<details>
<summary>Manual install</summary>

Clone the repository into your global OpenCode plugins folder. OpenCode loads it automatically.

```sh
git clone https://github.com/dhkimxx/opencode-lodestar ~/.config/opencode/plugins/opencode-lodestar
```

To update, run `git pull` in that folder.

</details>

## Usage

There is nothing to do. lodestar works whenever OpenCode compacts a session, whether automatically or through `/compact`. It adds nothing to the conversation you see: what it puts back goes only to the model.

## How it works

- **Tracking.** lodestar follows each session's tool calls: the files it reads and changes, the skills it loads, and its progress notes. This lives in OpenCode's plugin storage, one record per session, and is deleted with the session.
- **Restoring.** The restored files, plan, notes, and skills go into the request right after the summary. They are read from disk once per compaction and stay the same until the next one, so the provider's prompt cache keeps working. Files over about 5,000 tokens come back as a path the agent can read again. The whole restoration may use up to 20% of the size the conversation had when it was compacted, with a floor of 10,000 tokens and a ceiling of 40,000, and never more than 20% of the model's context window.
- **Reminders.** The recap request and the changed-file notice are added to a single request and never saved in the session.

## With other plugins

- A plugin that replaces OpenCode's compaction entirely leaves lodestar's restore step idle, since lodestar only acts on OpenCode's own compactions.
- lodestar doesn't prune old tool output. That is a separate job, done by plugins such as Dynamic Context Pruning.

## Results

Measured on [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os): 30 real issues from 10 open-source repositories, each worked by OpenCode alone and by OpenCode with lodestar. Four models took part: GLM-5.3 Flash, DeepSeek V4.1 Flash, GPT-6.1 Sol, and GPT-6 Luna, all at reasoning effort `high`. Every run was graded by the task's hidden tests. Compaction started at 50,000 tokens.

| Per run, over 120 pairs | OpenCode alone | With lodestar |
| --- | --- | --- |
| Tasks resolved | 110 | 109 |
| Prompt tokens | 1,098k | 949k (−14%) |
| Tool calls | 58 | 52 (−11%) |
| Files read again after compaction | 4.2 | 2.3 (−46%) |

lodestar acts after a compaction, and in the 52 pairs where one happened, its runs used 18% fewer prompt tokens and 16% fewer tool calls, and finished 16% sooner. All of these differences are larger than run-to-run noise.

Most of the tokens saved were cached ones, so uncached input and cost didn't change measurably. Most tasks were resolved either way, so the resolve rate doesn't tell the two apart. Details, results by model, and limitations are in [eval/results/v0.1.0.md](eval/results/v0.1.0.md).

## Development

You need [Bun](https://bun.sh).

```sh
git clone https://github.com/dhkimxx/opencode-lodestar
cd opencode-lodestar
bun install
bun run check
```

`bun run check` type-checks the code, runs the tests, and builds `dist/index.js`. To try your changes, point OpenCode at your clone in `~/.config/opencode/opencode.json`, then restart OpenCode:

```json
{
  "plugins": ["/path/to/opencode-lodestar"]
}
```

`dist/` is committed on purpose. GitHub installs don't run a build step, so they need the built JavaScript. Run `bun run bundle` and commit `dist/` with your change. CI fails if `dist/` is out of date.

Don't add `build`, `prepare`, `prepack`, or install scripts to `package.json`. npm runs an extra install step for GitHub packages that have them, and that step fails inside OpenCode.

The evaluation harness is described in [eval/README.md](eval/README.md). Releases are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
