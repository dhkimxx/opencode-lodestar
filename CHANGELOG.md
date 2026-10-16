# Changelog

All notable changes to this project are listed here.
This project follows [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-10-17

### Added

- Right after a compaction, the agent gets fresh copies of up to five recently changed files it was working with, its plan, its latest progress notes, and the skills it had loaded.
- The compaction summary is written with the session's own model and keeps every user request with its status, the user's rules word for word, errors with their fixes, and code details later work depends on. Any failure falls back to OpenCode's own summary.
- When a file the agent read changes on disk, the agent is told before its next step.
- After eight tool calls in a row with no message to the user, the agent is asked for a one-line recap.
- An evaluation harness that runs five scenarios against isolated OpenCode servers.

[0.1.0]: https://github.com/dhkimxx/opencode-lodestar/releases/tag/v0.1.0
