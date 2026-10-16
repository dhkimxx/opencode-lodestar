# Evaluation

These scripts measure whether lodestar helps an agent continue its work after compaction, and what it costs. Each run drives a real OpenCode session through a short task, compacts it at fixed points, and checks the result with tests the agent never saw.

## Scenarios

| ID | Fixture | What it checks |
| --- | --- | --- |
| S1 | `ledger` | Two rules given in the first message still hold after two compactions, when a later task tempts the agent to break them. |
| S2 | `router` | Conventions the agent read before a compaction are followed when it adds a route after it. |
| S3 | `textkit` | A six-item plan given once is carried out across three turns, with a compaction between each. |
| S4 | `ledger` | A file the user changed between turns is re-read before it is edited, not overwritten. |
| S5 | `calc` | Three bugs are fixed one per turn, with a compaction between turns, without repeating failed attempts. |

Scenarios live in `scenarios/`, and the projects they copy live in `fixtures/`.

## Configurations

| Name | Meaning |
| --- | --- |
| `A` | OpenCode alone. The baseline. |
| `B` | OpenCode with lodestar. |
| `B-T2`, `B-T3`, `B-T4`, `B-T6` | lodestar with one feature switched off, to measure what that feature adds. |

## Running

You need OpenCode 2 at `~/.opencode/bin/opencode` (or set `OPENCODE_BIN`), Bun, git, and a signed-in OpenCode Go account.

```sh
bun eval/run.ts --configs A,B --scenarios S1,S2,S3,S4,S5 --repeat 3 --concurrency 3
bun eval/report.ts eval/.runs/<run>/results.jsonl
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--configs` | `A` | Comma-separated configurations. |
| `--scenarios` | all | Comma-separated scenario IDs. |
| `--repeat` | `1` | Runs per configuration and scenario. |
| `--model` | `opencode-go/beam-free` | Model for every session. |
| `--context` | from a built-in table | The model's context window, in tokens. |
| `--threshold` | `60000` | Automatic compaction starts at this many tokens. |
| `--concurrency` | `2` | Runs at the same time. |
| `--turn-timeout` | 15 minutes | Time limit for one turn, in milliseconds. |
| `--bun-dir` | the directory of `bun` on `PATH` | Put on the agent's `PATH`, so it can run the tests. |
| `--out` | `eval/.runs/<time>` | Output directory. |

## How a run works

1. The fixture is copied into a fresh git repository.
2. A private OpenCode server starts with its own data, config, state, and cache directories. Your OpenCode Go credentials are copied into them in memory, and the directories are deleted when the run ends. Nothing touches your own OpenCode setup.
3. Automatic compaction is set to start at `--threshold` tokens, through the `compaction.buffer` setting, so that short tasks still compact mid-task. Other compaction settings keep their defaults.
4. Each step sends a message with `opencode run`, compacts through the `session.compact` API, or edits files the way a user would between turns.
5. The session is exported, metrics are computed from it, and the scenario's hidden tests run in the work directory.

Each run directory keeps `work/` (the project after the run), `export.json` (the session), `result.json` (metrics and checks), `turn-<n>.jsonl` (OpenCode's event output), and the server logs.

## Development switches

lodestar reads two environment variables that exist only for evaluation. They aren't user settings.

- `LODESTAR_DISABLE=T3,T4` switches off the listed features.
- `LODESTAR_TRACE=<file>` appends one JSON line for everything lodestar adds to a request, with an estimate of its size in tokens.

The harness sets them through the configurations above.
