# opencode-lodestar

Keeps [OpenCode](https://opencode.ai) on track through compaction.

When a long session fills the context window, OpenCode replaces the conversation with a summary. Work that lived only in the conversation gets lost: your exact request, the files the agent was editing, the test it just ran. The agent then spends its next steps reading it all again. lodestar puts that work back right after compaction, so the agent picks up where it left off.

## Features

- **Puts the work back.** Right after a compaction, the agent gets:
  - your request, word for word;
  - where it left off: its latest steps word for word, with what they returned;
  - the files it changed, as they are now;
  - the parts of other files it was reading;
  - its plan, its latest progress notes, and the skills it had loaded.
- **Keeps the prompt cache.** What lodestar adds is part of OpenCode's compaction request too, so compacting doesn't make the provider bill the whole conversation as new input.
- **Notices outside changes.** When a file the agent read changes on disk, through your editor or a teammate's pull, the agent is told before its next step. Changes from the agent's own commands, such as a formatter run, aren't reported.
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
opencode plugin add github:dhkimxx/opencode-lodestar#v0.3.0
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

- **Tracking.** lodestar follows each session: the requests you send, the files the agent reads and changes, its latest steps and what they returned, its latest test run, the skills it loads, and its progress notes. This lives in OpenCode's plugin storage, one record per session, and is deleted with the session.
- **Restoring.** What lodestar restores goes into the request right after the summary.
  - Files the agent changed come back whole, the most recently changed first. Files over about 5,000 tokens come back as their `git diff` instead, when the project uses git. `git status` comes along too.
  - Files the agent only read come back as the lines it read last.
  - The agent's latest steps come back word for word: what its commands and searches returned, and what it wrote. They take up to a tenth of the conversation that was compacted.
  - When a compaction comes right after the previous one, only your request, the latest steps, and the list of files come back.
  - Everything is read from disk once per compaction and stays the same until the next one. It also goes into OpenCode's compaction request, so the provider's prompt cache keeps working.
  - The whole restoration may use up to 20% of the size the conversation had when it was compacted, with a floor of 3,000 tokens and a ceiling of 40,000. It never takes more than 20% of the model's context window.
- **Reminders.** The recap request and the changed-file notice are added to a single request and never saved in the session.

## With other plugins

- A plugin that replaces OpenCode's compaction entirely leaves lodestar's restore step idle, since lodestar only acts on OpenCode's own compactions.
- lodestar doesn't prune old tool output. That is a separate job, done by plugins such as Dynamic Context Pruning.

## Results

Measured on [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) with DeepSeek V4.1 Flash at reasoning effort `high`. The tasks were hard issues from 10 open-source repositories. Each was worked once by OpenCode alone and once by OpenCode with lodestar, and graded by its hidden tests. Sessions were compacted whenever they reached 40,000 tokens, so most runs compacted, many of them several times.

| Per run, over 28 pairs | OpenCode alone | With lodestar |
| --- | --- | --- |
| Tasks resolved | 25 | 27 |
| Cost | $0.097 | $0.059 (−39%) |
| Uncached prompt tokens | 314k | 174k (−45%) |
| Tool calls | 136 | 80 (−41%) |
| Minutes | 15.1 | 9.8 (−36%) |
| Files read again after compaction | 32.9 | 9.5 (−71%) |

The differences in cost, uncached tokens, tool calls, time, and files read again are larger than run-to-run noise. The resolve rate isn't settled yet. lodestar resolved three tasks that OpenCode alone missed and missed one that OpenCode alone resolved, which 28 pairs can't tell apart from chance. Details and limitations are in [eval/results/v0.3.0.md](eval/results/v0.3.0.md).

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
