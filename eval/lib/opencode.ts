import { homedir } from "node:os"
import path from "node:path"

export const OPENCODE = process.env.OPENCODE_BIN ?? path.join(homedir(), ".opencode/bin/opencode")

export interface CliResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

// Runs an opencode command. stdin must stay closed: `opencode run` waits for EOF when stdin is not a terminal.
async function cli(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; stdin?: Uint8Array },
): Promise<CliResult> {
  const proc = Bun.spawn([OPENCODE, ...args], {
    cwd: options.cwd,
    // OpenCode takes the session directory from PWD, not from the process's working directory.
    env: { ...options.env, PWD: options.cwd },
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGTERM")
  }, options.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}

/**
 * The user's environment without OpenCode settings, so nothing from their own setup leaks into a run.
 * BUN_BE_BUN is dropped too: when this script runs on the Bun inside OpenCode, it would turn opencode into bun.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "BUN_BE_BUN" || key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  return env
}

/**
 * Reads one integration's credentials from the user's own OpenCode, or from a separate login kept under `home`, a
 * directory holding its own data, config, state, and cache dirs. The bytes stay in memory.
 */
export async function exportCredentials(integration: string, home?: string): Promise<Uint8Array> {
  const xdg: Record<string, string> = home
    ? {
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      }
    : {}
  const result = await cli(["auth", "export", integration, "--standalone"], {
    cwd: homedir(),
    env: { ...baseEnv(), ...xdg, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    timeoutMs: 120_000,
  })
  if (result.code !== 0) throw new Error(`auth export failed: ${result.stderr.trim()}`)
  return new TextEncoder().encode(result.stdout)
}
