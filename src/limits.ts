// Fixed values, chosen from Claude Code's public documentation and tuned by evaluation. There are no user settings.

/** Files restored after compaction, the most recently changed first. */
export const RESTORE_FILES = 5
/** A file larger than this comes back as a path reference instead of its content. */
export const RESTORE_FILE_TOKENS = 5_000
export const RESTORE_SKILL_TOKENS = 5_000
export const RESTORE_SKILLS_TOTAL = 25_000
export const RESTORE_PLAN_TOKENS = 5_000
/** Restoration may use this share of the context that was compacted, and of the model's window. */
export const RESTORE_SHARE = 0.2
export const RESTORE_MIN_TOKENS = 10_000
export const RESTORE_MAX_TOKENS = 40_000

/** After this long, the summary falls back to OpenCode's own. */
export const SUMMARY_TIMEOUT_MS = 120_000
/** The transcript sent for summarizing stays under this share of the model's window. */
export const SUMMARY_INPUT_SHARE = 0.5
export const SUMMARY_MAX_INPUT_TOKENS = 100_000

/** Tool calls in a row, with no text to the user, before a recap is requested. */
export const RECITE_AFTER_TOOL_CALLS = 8

/** Files checked for outside changes before each request, the most recently used first. */
export const STALE_CHECK_FILES = 50

/** Short progress notes kept from the agent's own messages. */
export const PROGRESS_NOTES = 3
export const PROGRESS_NOTE_CHARS = 600
