# Changelog

All notable changes to this project are listed here.
This project follows [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-10-17

### Added

- Right after a compaction, the agent gets fresh copies of up to five recently changed files it was working with, its plan, its latest progress notes, and the skills it had loaded.
- When a file the agent read changes on disk, the agent is told before its next step.
- After eight tool calls in a row with no message to the user, the agent is asked for a one-line recap.
- An evaluation harness that runs SWE-bench Pro tasks with and without lodestar, inside each task's own container.

[0.1.0]: https://github.com/dhkimxx/opencode-lodestar/releases/tag/v0.1.0
