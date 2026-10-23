# Evaluation results with GPT-6 Luna

Measured on 2026-10-23 and 2026-10-24 with OpenCode 2.1.2 and lodestar v0.3.1, which v0.4.0 changes only by adding the on/off switch.

## Setup

- **Tasks.** Eleven tasks from SWE-bench Pro V2, listed in `eval/tasks-luna.json`. They are the tasks of `eval/tasks-hard.json` where DeepSeek V4.1 Flash compacted at least three times at 40,000 tokens, picked so that sessions compact often. They come from eight repositories (NodeBB, element-web, flipt, vuls, teleport, openlibrary, webclients, qutebrowser).
- **Model.** `gpt-6-luna` at reasoning effort `high`, through a ChatGPT login.
- **Configurations.** A is OpenCode alone. B is OpenCode with lodestar. Each task ran twice per configuration, which makes 22 pairs. They aren't independent: the two runs of a task share the task. A run that ended in a provider error doesn't count, and none did.
- **Protocol.** As in [v0.3.0](v0.3.0.md): the agent works in the task's container with the network closed except for the model API, gets 50 minutes, and is graded in a fresh container by the task's hidden tests.
- **Compaction.** OpenCode's own compaction, set to start at 26,000 tokens, so that most runs compact.
- **Cost.** Through a ChatGPT login nothing is billed per token. Cost here is the token counts at the model's list prices, from a proxy that counts every request.

## Results

Means per run, over the 22 pairs.

| Per run | A (OpenCode alone) | B (with lodestar) | Change |
| --- | --- | --- | --- |
| Tasks resolved | 12 of 22 | 18 of 22 | |
| Cost | $0.034 | $0.056 | +66% |
| Cost per resolved task | $0.062 | $0.069 | +10% |
| Prompt tokens | 841k | 1,160k | +38% |
| Uncached prompt tokens | 212k | 382k | +81% |
| Output tokens | 13.2k | 20.8k | +58% |
| Model requests | 48 | 59 | +23% |
| Tool calls | 73 | 125 | +71% |
| Files read again after compaction | 19.3 | 59.9 | +210% |
| Compactions | 6.0 | 10.3 | +72% |
| Minutes | 6.0 | 7.7 | +28% |

Tool calls and re-reads count shell commands that print files (`cat`, `sed -n`) as well as the `read` tool, so they aren't comparable with the v0.3.0 rows, which count only the `read` tool. Cost per resolved task is total cost divided by tasks resolved.

## What to take from it

- lodestar resolved more tasks. In 8 of the 22 pairs only B resolved the task, in 2 only A did, in 10 both did, and in 2 neither did. B led in both rounds, 10 against 6 and 8 against 6. On DeepSeek V4.1 Flash it resolved 27 against 25.
- On this model it spends more per run, where on DeepSeek it spent less. The extra cost is not just the cost of resolving more: in the 10 pairs both resolved, B cost $0.061 against $0.018 for A, with about 2.8 times the tool calls and 5.8 times the compactions. Per resolved task the gap is small, $0.069 against $0.062, because OpenCode alone spends a lot on the tasks it fails. Why lodestar does more work here hasn't been checked.
- The difference in tasks resolved is consistent but not settled: 22 pairs from 11 tasks can't rule out chance.
- The tasks were picked for compacting often, so they favor what lodestar does.
