// Fixed values, chosen from Claude Code's public documentation and tuned by evaluation. There are no user settings.

/** The user's first request is restored up to this many tokens, keeping its start and its end. */
export const RESTORE_TASK_TOKENS = 3_000
/** Later requests: the latest few, each up to this many tokens. */
export const RESTORE_REQUESTS = 3
export const RESTORE_REQUEST_TOKENS = 1_000
/** A request is stored up to this many characters. */
export const REQUEST_CHARS = 16_000

/** The agent's latest tool calls, kept and restored. */
export const CALLS_KEPT = 5
/** The end of the latest test command's output. */
export const TEST_TAIL_LINES = 20
export const TEST_TAIL_CHARS = 2_000

/** Edited files too large to restore whole come back as a diff with this many lines of context. */
export const RESTORE_DIFF_TOKENS = 3_000
export const RESTORE_DIFF_CONTEXT = 10
/** Lines of `git status` restored. */
export const RESTORE_STATUS_LINES = 20

/** Files the agent only read: the ranges it read last, in this many of the most recently used ones. */
export const RESTORE_READ_FILES = 3
export const RESTORE_READ_TOKENS = 1_200
/** Line ranges kept per file. */
export const RANGES_KEPT = 4
/** A longer line is cut when restored. */
export const RESTORE_LINE_CHARS = 1_000

/** Edited files restored whole, the most recently edited first. */
export const RESTORE_FILES = 5
/** Further files the session used, listed by path only. */
export const RESTORE_OTHER_FILES = 30
/** A file larger than this comes back as a path reference instead of its content. */
export const RESTORE_FILE_TOKENS = 5_000
export const RESTORE_SKILL_TOKENS = 5_000
export const RESTORE_SKILLS_TOTAL = 25_000
export const RESTORE_PLAN_TOKENS = 5_000
/** Restoration may use this share of the context that was compacted, and of the model's window. */
export const RESTORE_SHARE = 0.2
export const RESTORE_MIN_TOKENS = 10_000
export const RESTORE_MAX_TOKENS = 40_000

/** Tool calls in a row, with no text to the user, before a recap is requested. */
export const RECITE_AFTER_TOOL_CALLS = 8

/** Files checked for outside changes before each request, the most recently used first. */
export const STALE_CHECK_FILES = 50
/** The agent's recent shell commands, kept to tell its own file changes, such as a formatter's, from outside ones. */
export const SHELL_RUNS_KEPT = 20
/** Allowance around a shell command's start and end when matching a file's change time to it. */
export const SHELL_RUN_SLACK_MS = 2_000

/** Short progress notes kept from the agent's own messages. */
export const PROGRESS_NOTES = 3
export const PROGRESS_NOTE_CHARS = 600
