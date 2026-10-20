# Changelog

All notable changes to this project are listed here.
This project follows [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-10-20

### Added

- After a compaction, the agent also gets your request word for word, its last five tool calls, and its latest test run with the end of its output.
- The files the agent changed come back whole, the most recently changed first. Files too large for that come back as their `git diff`, along with `git status`.
- From files the agent only read, the lines it read last come back.
- Two lines ask the agent to check its changes against your request, and to run the tests that cover them, before it finishes.
- The evaluation harness can compact sessions itself with `--compact-at`, and `eval/tasks-hard.json` holds a harder task set.

### Changed

- The changed-file notice no longer reports changes made while one of the agent's own shell commands ran, such as a formatter's or a test run's.
- The recap request asks the agent to carry on in the same response.

### Fixed

- Every compaction after the first billed the whole conversation as uncached input. What lodestar restores is now part of OpenCode's compaction request too, so the request matches the ones before it and the provider's prompt cache keeps working.

## [0.1.0] - 2026-10-17

### Added

- Right after a compaction, the agent gets fresh copies of up to five recently changed files it was working with, its plan, its latest progress notes, and the skills it had loaded.
- When a file the agent read changes on disk, the agent is told before its next step.
- After eight tool calls in a row with no message to the user, the agent is asked for a one-line recap.
- An evaluation harness that runs SWE-bench Pro tasks with and without lodestar, inside each task's own container.

[0.2.0]: https://github.com/dhkimxx/opencode-lodestar/releases/tag/v0.2.0
[0.1.0]: https://github.com/dhkimxx/opencode-lodestar/releases/tag/v0.1.0
