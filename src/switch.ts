import type { StorageDomain } from "@opencode/plugin/promise/storage"

const KEY = "enabled"

/** Where the current setting comes from, to say so when asked. */
export type Source = "command" | "config" | "default"

export type Action = "on" | "off" | "status"

/**
 * Whether lodestar is on. `/lodestar on` and `/lodestar off` are saved in plugin storage and win over `enabled` in the
 * plugin's options, which in turn wins over the default, on.
 */
export class Switch {
  private override?: boolean

  constructor(
    private readonly storage: StorageDomain,
    private readonly configured: boolean | undefined,
  ) {}

  async load() {
    try {
      const saved = await this.storage.get(KEY)
      if (typeof saved === "boolean") this.override = saved
    } catch {}
  }

  get on() {
    return this.override ?? this.configured ?? true
  }

  get source(): Source {
    return this.override !== undefined ? "command" : this.configured !== undefined ? "config" : "default"
  }

  async set(value: boolean) {
    this.override = value
    await this.storage.set(KEY, value).catch(() => {})
  }
}

/** `enabled` from the plugin's options in the OpenCode configuration, when it is a boolean. */
export function configured(options: Readonly<Record<string, unknown>> | undefined): boolean | undefined {
  const value = options?.enabled
  return typeof value === "boolean" ? value : undefined
}

/** What the user asked for in `/lodestar <word>`. No word asks for the status. */
export function parseAction(text: string): Action | undefined {
  const word = text.trim().toLowerCase().split(/\s+/)[0] ?? ""
  if (word === "" || word === "status") return "status"
  if (word === "on" || word === "off") return word
  return undefined
}

export const USAGE = "lodestar did not understand that. Use /lodestar on, /lodestar off, or /lodestar status."

/** The one line shown after the command. */
export function describe(state: Switch) {
  if (state.on) return "lodestar is on. It restores what you were working on after each compaction."
  const how =
    state.source === "config" ? "`enabled` is false in its options. Run /lodestar on to turn it on" : "Run /lodestar on to turn it on again"
  return `lodestar is off. It records and restores nothing. ${how}.`
}
