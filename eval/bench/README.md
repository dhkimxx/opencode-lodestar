# Harness benchmark

Runs the same SWE-bench Pro tasks through four coding agents on one model, one run at a time, and compares what each
spends and whether it resolves the task.

| | Harness | Version | Compaction |
| --- | --- | --- | --- |
| A | OpenCode | 2.1.2 | summary written by the model |
| B | OpenCode with lodestar | 2.1.2, lodestar from `--plugin` | the same, plus lodestar's restoration |
| C | omp | 18.12.6 | the server's compaction (`methodOrder: [remote]`) |
| D | Codex | 0.163.0 | the server's compaction, with an encrypted result |

All four use `gpt-6-luna` at effort `high` through the ChatGPT backend, signed in with the evaluation-only login
described in [../README.md](../README.md).

## What is the same, and what isn't

The same: the model and effort, the task and its instruction text, the container image, the 50-minute budget, the
network (the proxy lets only `chatgpt.com` through), approval (everything allowed), no web search, subagents, MCP,
plugins, LSP, or instruction files (AGENTS.md and the like), grading in a fresh container, and the way tokens are
counted.

Not the same, because it is what is being compared: each harness's system prompt, its tools and how it edits, how it
compacts, and its cache keys. `meter.jsonl` in each run keeps the first request's prompt size and its tool count.

## How tokens are counted

`meter.py` runs in mitmproxy and reads the model's own usage from every response, over HTTPS and over WebSocket.
Codex and omp don't write their compaction requests' use to their logs, so their own logs would undercount them. The
meter counts the same way for all four, and also shows the model and effort each request actually used.

Prompt tokens include cached ones, as the API reports them. Cost is the token counts at the model's list prices, for
comparing runs: through a ChatGPT login nothing is billed per token.

OpenCode also asks for a session title, at effort `none`. It is counted in the totals and left out of the prompt sizes.

## Compaction threshold

Every harness compacts by itself, at the size set with `--threshold`: one number for all, or one for each
(`A=45000,B=45000,C=52000,D=60000`). The harnesses start with prompts of different sizes, so a threshold that leaves
each the same room beyond its own starting prompt is fairer than one number. P0 below measures the starting prompts.

## Running

```sh
bun eval/bench.ts --tasks plans/bench12-tasks.json --harnesses A,B,C,D --threshold A=…,B=…,C=…,D=… --out <dir>
bun eval/bench-report.ts <dir> --tasks
```

Within each task the harnesses run in an order fixed by `--seed`. Runs that already counted are skipped, so running
again finishes what is left. `bench-report.ts` compares only the tasks every harness finished.

## Known gaps

- Codex's code mode runs several tools from one piece of JavaScript, and the rollout doesn't record the tools it
  calls. Its tool counts come from the events `codex exec --json` prints, and may undercount.
- Re-reads after a compaction need the order of tool calls and compactions. Codex's rollout doesn't give it.
- Tool outputs are cut at different sizes: Codex at 10k tokens, omp at its own limits, OpenCode at its own.
