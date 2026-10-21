import { version } from "../package.json"

/**
 * OpenCode loads a plugin once for each entry that names it, so `github:dhkimxx/opencode-lodestar` next to
 * `github:dhkimxx/opencode-lodestar#v0.3.0` runs two copies in one server. If both acted, every request would carry two
 * restorations. The copies find each other through one shared registry, and only the leader acts: the newest version,
 * and between equal versions the copy set up last, the way a later entry overrides an earlier one. When the leader is
 * unloaded, the next one takes over.
 *
 * Copies of other versions read the same registry, so its key and shape must not change.
 */
const REGISTRY = Symbol.for("opencode-lodestar.copies")

export interface Copy {
  readonly version: string
  readonly order: number
}

interface Registry {
  readonly copies: Set<Copy>
  next: number
}

export function joinCopies(scope: object = globalThis, own = version) {
  const holder = scope as { [REGISTRY]?: Registry }
  const registry = (holder[REGISTRY] ??= { copies: new Set(), next: 0 })
  const self: Copy = { version: own, order: registry.next++ }
  registry.copies.add(self)
  return {
    leads: () => leader(registry.copies) === self,
    leave: () => void registry.copies.delete(self),
  }
}

export function leader(copies: Iterable<Copy>): Copy | undefined {
  let best: Copy | undefined
  for (const copy of copies) {
    if (!best) best = copy
    else {
      const newer = compareVersions(copy.version, best.version)
      if (newer > 0 || (newer === 0 && copy.order > best.order)) best = copy
    }
  }
  return best
}

/** Compares `x.y.z` versions. A pre-release such as `0.4.0-beta.1` comes before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre] = value.split("-", 2)
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre.localeCompare(right.pre, "en", { numeric: true })
}
