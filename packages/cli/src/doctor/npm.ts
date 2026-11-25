/**
 * What the npm registry knows about a package: its versions and the package.json of each, so `doctor` can tell
 * which version of a plugin supports the project's @mavonengine/core.
 */

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

export interface Packument {
  name: string
  /** The `latest` dist-tag */
  latest?: string
  /** The package.json of every published version */
  versions: Record<string, Record<string, any>>
}

export interface NpmRegistryOptions {
  url?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

const TRAILING_SLASHES_RE = /\/+$/

export class NpmRegistry {
  readonly url: string
  /** Why the registry couldn't be reached, once it couldn't */
  unreachable: string | undefined
  private readonly timeoutMs: number
  private readonly fetch: typeof globalThis.fetch
  private readonly cache = new Map<string, Promise<Packument | undefined>>()

  constructor({ url = NPM_REGISTRY_URL, timeoutMs = 10_000, fetch = globalThis.fetch }: NpmRegistryOptions = {}) {
    this.url = url.replace(TRAILING_SLASHES_RE, '')
    this.timeoutMs = timeoutMs
    this.fetch = fetch
  }

  /** The package, or undefined when the registry doesn't have it or can't be reached. Asked once per package */
  get(pkg: string): Promise<Packument | undefined> {
    let packument = this.cache.get(pkg)
    if (!packument) {
      packument = this.load(pkg)
      this.cache.set(pkg, packument)
    }
    return packument
  }

  private async load(pkg: string): Promise<Packument | undefined> {
    if (this.unreachable)
      return undefined

    // Scoped names go in one path segment: @scope%2Fname
    const url = `${this.url}/${pkg.replace('/', '%2F')}`
    let res: Response
    try {
      // The full document: the abbreviated one leaves out the `mavonengine` field
      res = await this.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    }
    catch (err) {
      this.unreachable ??= `can't reach ${this.url}: ${(err as Error).message}`
      return undefined
    }

    if (res.status === 404)
      return undefined
    if (!res.ok) {
      this.unreachable ??= `${this.url} answered ${res.status} ${res.statusText}`
      return undefined
    }

    try {
      const doc = await res.json() as { 'name'?: string, 'dist-tags'?: Record<string, string>, 'versions'?: Record<string, Record<string, any>> }
      return { name: doc.name ?? pkg, latest: doc['dist-tags']?.latest, versions: doc.versions ?? {} }
    }
    catch (err) {
      this.unreachable ??= `${url} is not valid JSON: ${(err as Error).message}`
      return undefined
    }
  }
}
