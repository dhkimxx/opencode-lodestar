import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"

const GIT_TIMEOUT_MS = 5_000

/** Runs git and returns its output, or undefined if it fails. It never takes the index lock or asks for input. */
function git(directory: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      {
        cwd: directory,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    )
  })
}

/** A file's path inside the repository, or undefined when it lies outside. Follows symlinks the way git does. */
async function inside(root: string, file: string): Promise<string | undefined> {
  const real = await realpath(file).catch(() =>
    realpath(path.dirname(file)).then(
      (directory) => path.join(directory, path.basename(file)),
      () => undefined,
    ),
  )
  if (!real) return undefined
  const relative = path.relative(root, real)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined
}

export interface Changes {
  /** The repository's top directory. */
  root: string
  /** `git diff` against HEAD for each tracked file that changed, keyed by the file's absolute path. */
  diffs: Map<string, string>
  /** Edited files that git doesn't track yet, usually ones the agent created. */
  untracked: string[]
  /** Edited files that git can't describe: outside the repository, or ignored. */
  outside: string[]
  /** `git status --short` for the whole repository. */
  status: string[]
}

/**
 * What changed in the files the agent edited, according to git. Undefined when the session's directory isn't in a git
 * repository, or git isn't installed.
 */
export async function changesOf(directory: string, files: string[], context: number): Promise<Changes | undefined> {
  const top = (await git(directory, ["rev-parse", "--show-toplevel"]))?.trim()
  if (!top) return undefined
  const root = await realpath(top).catch(() => top)
  const located = await Promise.all(files.map(async (file) => ({ file, relative: await inside(root, file) })))
  const tracked = new Map(located.flatMap(({ file, relative }) => (relative ? [[relative, file] as const] : [])))
  const outside = located.filter(({ relative }) => !relative).map(({ file }) => file)
  const specs = [...tracked.keys()].map((relative) => `:(literal)${relative}`)

  const diffs = new Map<string, string>()
  const untracked: string[] = []
  if (specs.length > 0) {
    const hasHead = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])) !== undefined
    const diff = await git(root, [
      "diff",
      ...(hasHead ? ["HEAD"] : []),
      `-U${context}`,
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...specs,
    ])
    for (const chunk of (diff ?? "").split(/^(?=diff --git )/m)) {
      const name = chunk.match(/^\+\+\+ b\/(.*)$/m)?.[1] ?? chunk.match(/^--- a\/(.*)$/m)?.[1]
      const file = name === undefined ? undefined : tracked.get(name)
      if (file && chunk.trim()) diffs.set(file, chunk.trimEnd())
    }
    const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs])
    for (const relative of (others ?? "").split("\0").filter(Boolean)) {
      const file = tracked.get(relative)
      if (file) untracked.push(file)
    }
    // Ignored files show up in neither list. The caller restores them whole, like files outside the repository.
    const ignored = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...specs])
    for (const relative of (ignored ?? "").split("\0").filter(Boolean)) {
      const file = tracked.get(relative)
      if (file) outside.push(file)
    }
  }
  const status = ((await git(root, ["status", "--short", "--untracked-files=normal"])) ?? "").split("\n").filter(Boolean)
  return { root, diffs, untracked, outside, status }
}
