# Evaluation

These scripts measure whether lodestar helps an agent keep working after compaction, and what it costs. They run tasks from [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) V2 through OpenCode, once without lodestar (`A`) and once with it (`B`), and compare the two run by run. These tasks are real issues in real repositories, long enough that sessions compact while the agent works.

Each run follows the benchmark's own protocol:

- **The agent works inside the task's container**, so its commands run in the task's environment. OpenCode, ripgrep, and this repository are mounted read-only. Alpine images get OpenCode's musl build.
- **The network is closed while the agent works.** Task containers sit on an internal Docker network, `lodestar-eval`. Their only way out is a Squid proxy, `lodestar-eval-proxy`, that allows the model APIs and nothing else (`squid.conf`). Web search is off.
- **The agent gets 50 minutes.** When time runs out, its partial work is graded.
- **Grading happens in a fresh container.** The agent's diff is applied there and the task's own verifier runs. Grading has normal network access, since some Go tasks fetch modules during tests.

Results for the current release are in [results/v0.3.0.md](results/v0.3.0.md).

## Setup

1. Docker, and ripgrep at `~/.cache/opencode/bin/rg`. OpenCode downloads ripgrep the first time it searches.
2. The tasks:

   ```sh
   git clone --depth 1 https://github.com/scaleapi/SWE-bench_Pro-os ~/.cache/lodestar-eval/SWE-bench_Pro-os
   ```

3. Credentials. OpenCode Go models use the key from your own OpenCode. OpenAI models need a separate login made only for evaluation. ChatGPT refresh tokens work once, so a copy of your own login that refreshes would sign you out.

   ```sh
   D=~/.local/share/lodestar-eval/openai
   mkdir -p $D && chmod 700 $D
   XDG_DATA_HOME=$D/data XDG_CONFIG_HOME=$D/config XDG_STATE_HOME=$D/state XDG_CACHE_HOME=$D/cache \
     opencode auth login openai --standalone --method chatgpt-headless
   ```

   Its access token lasts ten days. The runner refuses to start when less than a day is left, because each container holds a copy, and a copy that refreshed the token would invalidate the others.

## Running

```sh
bun eval/run.ts --tasks eval/tasks-hard.json \
  --models 'opencode-go/deepseek-v4.1-flash#high' --configs A,B --compact-at 40000 --concurrency 3 --prune-images
```

| Option | Default | What it does |
| --- | --- | --- |
| `--tasks` | | Comma-separated task IDs, or a JSON file with an array of them. |
| `--models` | `opencode-go/glm-5.3-flash#high` | Comma-separated models, with the reasoning variant after `#`. |
| `--configs` | `A,B` | `A` is OpenCode alone, `B` is OpenCode with lodestar. `B-T2`, `B-T4`, and `B-T6` switch off one feature, to measure what it adds. `C` runs the lodestar checkout given by `--c-plugin`, to compare two versions. |
| `--c-plugin` | | Another lodestar checkout, with a built `dist/`, for config `C`. |
| `--compact-at` | | The harness compacts the session whenever a request reaches this many tokens, and OpenCode keeps its own threshold. Use this for new runs. |
| `--threshold` | `50000` | Without `--compact-at`, OpenCode's own auto compaction starts at this many tokens. |
| `--budget` | `50` | Minutes the agent gets. |
| `--concurrency` | `3` | Runs at a time. Each container may use up to 6 GB of memory. |
| `--prune-images` | off | Removes each task's image once all of its runs are done. The images are several GB each. |
| `--out` | `eval/.runs/<time>` | Where runs are written. Run again with the same directory to finish what is left: runs that already counted are skipped. |

Compaction has to be forced early, because sessions on these tasks rarely grow anywhere near the models' windows of 272k to 1M tokens. At a realistic threshold, almost none would compact. There are two ways to force it.

- **`--compact-at` is the better one.** OpenCode keeps its default threshold. The harness reads the size of each request from the agent's events and asks for a compaction when it reaches the given number.
  - It checks every five seconds, so a compaction can come a step or two after the size is reached.
  - OpenCode then has room to send the compaction request as it is.
- **`--threshold` lowers OpenCode's own threshold.** In OpenCode 2.0, OpenCode also caps its compaction request at that threshold, and it estimates the request's size at four characters per token. When the estimate doesn't fit, it rebuilds the history as plain text, which loses the prompt cache with or without lodestar. OpenCode 2.1 sizes the request by the model's window instead, so this no longer happens there.
  - At 40,000 tokens, this happened to 46% of DeepSeek V4.1 Flash's compactions.
  - The v0.3.0 results used `--compact-at 40000` instead, and no compaction request was rebuilt.

Each run reads its model's limits inside the container, with the run's own login, because they depend on it: through a ChatGPT login, OpenAI models accept less than through the API.

A run that fails for reasons outside the agent doesn't count, such as a provider error or a failed image download. Running again with the same `--out` redoes it. Rate-limited runs wait and retry, and ChatGPT usage limits get waits of up to five hours.

## Output

Each run directory keeps `turn.jsonl` (the agent's events), `export.json` (the session), `model.patch`, `verifier.log`, `reward.txt`, `trace.jsonl` (B only), and `result.json`. `results.jsonl` holds one line per run.

## Tools

- `compare.ts` pairs A and B runs of the same task and model. It reports the mean difference in each measure with a 95% bootstrap interval.
  - It reports all pairs, then the pairs where A or B compacted, then the pairs where both did, since lodestar only restores after a compaction.
  - `--model` keeps only the models whose name contains the given text, `--pair C,B` compares two other configurations, and `--tasks` lists every pair.
  - Uncached prompt tokens include cache writes, because providers with explicit caching report new prompt tokens that way.
- `regrade.ts` grades finished runs again from their saved patches, for example after a fix to grading. The agents don't run again.
- `select.ts` makes the task lists. Both take tasks from every repository except `tutao/tutanota`, which has only four tasks, and both leave out the HARD-51 subset, which most model families fail, unless noted.
  - `tasks.json` holds three tasks per repository, from those that touch at least three files: the ones whose reference patch size is closest to that repository's 80th percentile. That makes them long but still solvable.
  - `tasks-hard.json` (`select.ts --hard`) holds four tasks per repository, none of them in `tasks.json`. Three come from the tasks that touch at least four files, picked closest to the 95th percentile. The fourth is the repository's HARD-51 task with the largest reference patch.

## Evaluation switches

lodestar reads two environment variables that exist only for evaluation. They aren't user settings.

- `LODESTAR_DISABLE=T4,T6` switches off the listed features. The `B-T*` configurations set it.
- `LODESTAR_TRACE=<file>` appends one JSON line for everything lodestar adds to a request, with an estimate of its size in tokens. The runner sets it for every B run.

## Cleaning up

The proxy and the network stay after a run. To remove them:

```sh
docker rm -f lodestar-eval-proxy && docker network rm lodestar-eval
```
