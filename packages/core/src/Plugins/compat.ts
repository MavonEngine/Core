/**
 * Which @mavonengine/core versions a plugin works with. Plugins say so with a semver range, in `engine` of the
 * `mavonengine` field of their package.json (or, without one, in their `@mavonengine/core` peer dependency).
 *
 * The range syntax is npm's: `1.2.3`, `=1.2.3`, `>=1.2.0 <2`, `^0.0.25`, `~1.2`, `1.x`, `*`, `1.0.0 - 1.4.0`
 * and `||` between alternatives. A prerelease version only matches a range that names a prerelease of the same
 * version, as in npm. Runs in Node and in the browser.
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
}

type Op = '<' | '<=' | '>' | '>=' | '='

interface Comparator {
  op: Op
  version: SemVer
  /** Written in the range, rather than made up to express `^`, `~` or `1.x` */
  explicit: boolean
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Z-]+(?:\.[0-9A-Z-]+)*))?(?:\+[0-9A-Z-]+(?:\.[0-9A-Z-]+)*)?$/i
const PARTIAL_RE = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Z-]+(?:\.[0-9A-Z-]+)*))?(?:\+[0-9A-Z-]+(?:\.[0-9A-Z-]+)*)?$/i
const COMPARATOR_RE = /^(<=|>=|~>|[<>=^~])?\s*([^\s<>=^~]\S*)$/
const HYPHEN_RE = /^(\S+)\s+-\s+(\S+)$/
const OPERATOR_SPACE_RE = /(<=|>=|~>|[<>=^~])\s+/g
const WHITESPACE_RE = /\s+/
const NUMERIC_RE = /^\d+$/
const WILDCARD_RE = /^[x*]$/i

function prereleaseOf(text: string | undefined): (string | number)[] {
  return text
    ? text.split('.').map(part => NUMERIC_RE.test(part)
        ? Number(part)
        : part)
    : []
}

/** A full version like `1.2.3` or `1.2.3-beta.1`, or undefined */
export function parseVersion(version: string): SemVer | undefined {
  const match = VERSION_RE.exec(version.trim())
  if (!match)
    return undefined

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseOf(match[4]),
  }
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key])
      return a[key] - b[key]
  }

  // A version without a prerelease is newer than its prereleases
  if (!a.prerelease.length || !b.prerelease.length)
    return b.prerelease.length - a.prerelease.length

  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined || y === undefined) {
      return x === undefined
        ? -1
        : 1
    }
    if (x === y)
      continue
    if (typeof x === 'number' && typeof y === 'number')
      return x - y
    // Numbers sort before words
    if (typeof x === 'number' || typeof y === 'number') {
      return typeof x === 'number'
        ? -1
        : 1
    }
    return x < y
      ? -1
      : 1
  }

  return 0
}

function version(major: number, minor: number, patch: number, prerelease: (string | number)[] = []): SemVer {
  return { major, minor, patch, prerelease }
}

/** The lowest prerelease of a version: `<2.0.0-0` keeps 2.0.0's prereleases out too */
function floor(major: number, minor: number, patch: number): SemVer {
  return version(major, minor, patch, [0])
}

/**
 * One comparator of a range, like `^1.2`, as the primitive comparators it stands for. Undefined when it isn't one.
 */
function desugar(text: string): Comparator[] | undefined {
  const match = COMPARATOR_RE.exec(text)
  if (!match)
    return undefined

  const op = match[1] === '~>'
    ? '~'
    : match[1] ?? ''
  const partial = PARTIAL_RE.exec(match[2])
  if (!partial)
    return undefined

  const parts = [partial[1], partial[2], partial[3]]
  // Everything after a wildcard is a wildcard too: 1.x.3 is 1.x
  const wild = parts.findIndex(part => part === undefined || WILDCARD_RE.test(part))
  const given = wild === -1
    ? 3
    : wild
  const [major, minor, patch] = parts.map((part, i) => i < given
    ? Number(part)
    : 0)
  const pre = given === 3
    ? prereleaseOf(partial[4])
    : []
  const exact = version(major, minor, patch, pre)
  const make = (o: Op, v: SemVer, explicit = false): Comparator => ({ op: o, version: v, explicit })

  if (given === 0) {
    return op === '<' || op === '>'
      ? [
          make('<', floor(0, 0, 0)),
        ]
      : []
  }

  // The first version past what is given: 1.2 → 1.3.0, 1 → 2.0.0
  const next = given === 1
    ? floor(major + 1, 0, 0)
    : floor(major, minor + 1, 0)

  switch (op) {
    case '':
    case '=':
      return given === 3
        ? [
            make('=', exact, true),
          ]
        : [
            make('>=', version(major, minor, 0)),
            make('<', next),
          ]
    case '>':
      return given === 3
        ? [
            make('>', exact, true),
          ]
        : [
            make('>=', version(next.major, next.minor, 0)),
          ]
    case '>=':
      return [
        make('>=', exact, true),
      ]
    case '<':
      return [
        make('<', given === 3
          ? exact
          : floor(major, minor, 0), given === 3),
      ]
    case '<=':
      return given === 3
        ? [
            make('<=', exact, true),
          ]
        : [
            make('<', next),
          ]
    case '~':
      return [
        make('>=', exact, true),
        make('<', given === 1
          ? floor(major + 1, 0, 0)
          : floor(major, minor + 1, 0)),
      ]
    case '^': {
      let upper: SemVer
      if (major > 0 || given === 1)
        upper = floor(major + 1, 0, 0)
      else if (minor > 0 || given === 2)
        upper = floor(0, minor + 1, 0)
      else
        upper = floor(0, 0, patch + 1)
      return [
        make('>=', exact, true),
        make('<', upper),
      ]
    }
  }

  return undefined
}

/**
 * A range as alternatives (`||`), each a list of comparators that must all hold. Undefined when it isn't a range.
 */
function parseRange(range: string): Comparator[][] | undefined {
  const sets: Comparator[][] = []

  for (const alternative of range.split('||')) {
    const text = alternative.trim()
    const set: Comparator[] = []

    const hyphen = HYPHEN_RE.exec(text)
    if (hyphen) {
      const from = desugar(`>=${hyphen[1]}`)
      const to = desugar(`<=${hyphen[2]}`)
      if (!from || !to)
        return undefined
      set.push(...from, ...to)
    }
    else if (text) {
      for (const part of text.replace(OPERATOR_SPACE_RE, '$1').split(WHITESPACE_RE)) {
        const comparators = desugar(part)
        if (!comparators)
          return undefined
        set.push(...comparators)
      }
    }

    sets.push(set)
  }

  return sets
}

/** Whether `range` is a semver range this module understands */
export function validRange(range: string): boolean {
  return typeof range === 'string' && parseRange(range) !== undefined
}

function holds(v: SemVer, { op, version: other }: Comparator): boolean {
  const order = compareVersions(v, other)
  switch (op) {
    case '<': return order < 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '>=': return order >= 0
    case '=': return order === 0
  }
}

function sameRelease(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}

/**
 * Whether `version` is in `range`. False when either isn't valid.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const sets = parseRange(range)
  if (!v || !sets)
    return false

  return sets.some(set => set.every(comparator => holds(v, comparator))
    && (!v.prerelease.length || set.some(c => c.explicit && c.version.prerelease.length && sameRelease(c.version, v))))
}

/** The newest of `versions` that is in `range` */
export function maxSatisfying(versions: Iterable<string>, range: string): string | undefined {
  let best: { text: string, version: SemVer } | undefined
  for (const text of versions) {
    const v = parseVersion(text)
    if (v && satisfies(text, range) && (!best || compareVersions(v, best.version) > 0))
      best = { text, version: v }
  }
  return best?.text
}

/** The range of @mavonengine/core versions a package.json says it supports: `mavonengine.engine`, else its peer dependency */
export function engineRangeOf(packageJson: Record<string, any> | undefined): string | undefined {
  const engine = packageJson?.mavonengine?.engine ?? packageJson?.peerDependencies?.['@mavonengine/core']
  return typeof engine === 'string' && engine.trim()
    ? engine.trim()
    : undefined
}

export type EngineCompat = 'compatible' | 'incompatible' | 'unknown'

/**
 * Whether a plugin that supports `engine` works with @mavonengine/core `coreVersion`. Unknown when the plugin
 * doesn't say, the range can't be read, or the core version isn't known.
 */
export function engineCompat(engine: string | undefined, coreVersion: string | undefined): EngineCompat {
  if (!engine || !coreVersion || !validRange(engine) || !parseVersion(coreVersion))
    return 'unknown'

  return satisfies(coreVersion, engine)
    ? 'compatible'
    : 'incompatible'
}
