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

OpenCode 2.1 or newer. Tested with OpenCode 2.1.2. OpenCode 1 is not supported.

## Install

To install it along with opencode-ask and opencode-delete, use [opencode-kit](https://github.com/dhkimxx/opencode-kit). It also removes copies left over from earlier installs:

```sh
curl -fsSL https://raw.githubusercontent.com/dhkimxx/opencode-kit/main/install.sh | bash
```

To install only this plugin:

```sh
opencode plugin add github:dhkimxx/opencode-lodestar
```

This installs the plugin and adds it to the `plugins` list in your `opencode.json`. If OpenCode is already running, restart it.

To install a specific release, add its tag:

```sh
opencode plugin add github:dhkimxx/opencode-lodestar#v0.4.0
```

Update or remove the plugin with the same name you installed it with:

```sh
opencode plugin update github:dhkimxx/opencode-lodestar
opencode plugin remove github:dhkimxx/opencode-lodestar
```

To get a newer version, use `opencode plugin update`. Removing the plugin and adding it again reuses the copy OpenCode downloaded before.

<details>
<summary>Manual install</summary>

Clone the repository into your global OpenCode plugins folder. OpenCode loads it automatically.

```sh
git clone https://github.com/dhkimxx/opencode-lodestar ~/.config/opencode/plugins/opencode-lodestar
```

To update, run `git pull` in that folder.

</details>

## Usage

There is nothing to do. lodestar works whenever OpenCode compacts a session, whether automatically or through `/compact`. Apart from the one line `/lodestar` prints, it adds nothing to the conversation you see: what it puts back goes only to the model.

### Turning it on and off

| To do this | Do this |
| --- | --- |
| Turn lodestar off | `/lodestar off` |
| Turn it on again | `/lodestar on` |
| See whether it is on | `/lodestar status` |

While it is off, lodestar records and restores nothing, and OpenCode compacts as it does without it. What lodestar knew about a session before you turned it off is kept, but it misses what happened in between. The choice is saved, so it lasts across restarts and applies to every session.

To start with lodestar off, set `enabled` in the plugin's options in `opencode.json`. A choice made with `/lodestar` wins over this.

```json
{ "plugins": [{ "package": "github:dhkimxx/opencode-lodestar", "options": { "enabled": false } }] }
```

The line `/lodestar` prints is hidden from the model.

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

- **DeepSeek V4.1 Flash:** about the same tasks resolved (25 against 27), at 39% lower cost.
- **GPT-6 Luna:** more tasks resolved (12 against 18), at 66% higher cost.

Measured on [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os), with each task worked by OpenCode alone and by OpenCode with lodestar, then graded by its hidden tests. Sessions were compacted early so that most runs compacted, many of them several times.

### DeepSeek V4.1 Flash

28 task pairs, at reasoning effort `high`.

| Per run | OpenCode alone | With lodestar |
| --- | --- | --- |
| Tasks resolved | 25 | 27 |
| Cost | $0.097 | $0.059 (−39%) |
| Tool calls | 136 | 80 (−41%) |
| Minutes | 15.1 | 9.8 (−36%) |
| Files read again after compaction | 32.9 | 9.5 (−71%) |

In 3 of the 28 pairs only lodestar resolved the task, and in 1 only OpenCode alone did. The differences in cost, tool calls, time, and files read again are larger than run-to-run noise. The resolve rate isn't settled: 28 pairs can't tell the difference apart from chance. Details are in [eval/results/v0.3.0-deepseek-v4.1-flash.md](eval/results/v0.3.0-deepseek-v4.1-flash.md).

### GPT-6 Luna

22 task pairs, at reasoning effort `high`.

| Per run, over 22 pairs | OpenCode alone | With lodestar |
| --- | --- | --- |
| Tasks resolved | 12 | 18 |
| Cost | $0.034 | $0.056 (+66%) |
| Cost per resolved task | $0.062 | $0.069 (+10%) |
| Uncached prompt tokens | 212k | 382k (+81%) |
| Tool calls | 73 | 125 (+71%) |
| Files read again after compaction | 19.3 | 59.9 (+210%) |
| Compactions | 6.0 | 10.3 (+72%) |
| Minutes | 6.0 | 7.7 (+28%) |

In 8 of the 22 pairs only lodestar resolved the task, and in 2 only OpenCode alone did. Both resolved 10 and neither resolved 2. On those 10, lodestar cost about 3.3 times as much ($0.061 against $0.018). The difference in tasks resolved isn't settled: 22 pairs from 11 tasks can't rule out chance. Tool calls and re-reads count shell commands that print files as well as the read tool, so they aren't comparable with the DeepSeek rows. Details are in [eval/results/v0.3.1-gpt-6-luna.md](eval/results/v0.3.1-gpt-6-luna.md).

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
