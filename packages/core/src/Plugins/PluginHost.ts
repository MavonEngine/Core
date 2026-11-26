import type winston from 'winston'
import type Logger from '../Utils/Logger'
import type { LoadedPlugin } from './types'

type AnyFn = (...args: any[]) => any

/** Names of the plugin's optional methods */
type HookName<P> = { [K in keyof P]-?: NonNullable<P[K]> extends AnyFn ? K : never }[keyof P]

/** A hook's arguments without the trailing context, which the host passes itself */
type HookArgs<P, K extends keyof P> = NonNullable<P[K]> extends (...args: infer A) => any
  ? A extends [...infer Head, any] ? Head : []
  : never

type HookResult<P, K extends keyof P> = NonNullable<P[K]> extends (...args: any[]) => infer R ? R : never

interface Entry<P, C> {
  loaded: LoadedPlugin<P>
  ctx: C
  /** Hooks turned off because they threw */
  failed: Set<PropertyKey>
}

/**
 * Runs the lifecycle hooks of a set of plugins, in order. A hook that throws is logged and turned off
 * for that plugin, so a broken plugin can't take the game loop down or flood the log every tick.
 */
export default class PluginHost<P extends { name?: string }, C> {
  private entries: Entry<P, C>[]
  /** What each plugin's `api()` returned, by package */
  private apis = new Map<string, unknown>()

  constructor(
    plugins: LoadedPlugin<P>[],
    makeContext: (plugin: LoadedPlugin<P>) => C,
    private logger: winston.Logger | Logger | null | undefined,
    side: 'client' | 'server',
  ) {
    this.entries = plugins.map(loaded => ({
      loaded,
      ctx: makeContext(loaded),
      failed: new Set(),
    }))

    for (const { loaded } of this.entries)
      this.logger?.info(`Plugin loaded: ${PluginHost.label(loaded)} (${side})`)
  }

  static label(loaded: LoadedPlugin<{ name?: string }>): string {
    const name = loaded.plugin.name
    return name && name !== loaded.package
      ? `${name} (${loaded.package})`
      : loaded.package
  }

  get size(): number {
    return this.entries.length
  }

  get plugins(): LoadedPlugin<P>[] {
    return this.entries.map(e => e.loaded)
  }

  /**
   * Call `hook` on every plugin that has it, with `args` followed by the plugin's context.
   */
  run<K extends HookName<P>>(hook: K, ...args: HookArgs<P, K>): void {
    for (const entry of this.entries)
      this.call(entry, hook, args)
  }

  /**
   * Like `run()`, but `around` makes each plugin's call, so it can tell what that one plugin did.
   */
  runAround<K extends HookName<P>>(hook: K, around: (plugin: LoadedPlugin<P>, call: () => void) => void, ...args: HookArgs<P, K>): void {
    for (const entry of this.entries)
      around(entry.loaded, () => void this.call(entry, hook, args))
  }

  /**
   * Call `hook` on every plugin and collect what each returns, leaving out plugins that returned nothing.
   */
  collect<K extends HookName<P>>(hook: K, ...args: HookArgs<P, K>): { plugin: LoadedPlugin<P>, result: Exclude<HookResult<P, K>, undefined> }[] {
    const results = []
    for (const entry of this.entries) {
      const result = this.call(entry, hook, args)
      if (result !== undefined)
        results.push({ plugin: entry.loaded, result })
    }
    return results
  }

  /**
   * Call `hook` on the plugin of package `pkg` only. Undefined when there is no such plugin, it has no such hook or it threw.
   */
  callOn<K extends HookName<P>>(pkg: string, hook: K, ...args: HookArgs<P, K>): HookResult<P, K> | undefined {
    const entry = this.entries.find(e => e.loaded.package === pkg)
    return entry && this.call(entry, hook, args)
  }

  /**
   * The context of the plugin of package `pkg`, for a caller that calls one of its hooks itself, e.g. one whose
   * throws must not turn the hook off. Undefined when there is no such plugin, also after `remove()`.
   */
  contextOf(pkg: string): C | undefined {
    return this.entries.find(e => e.loaded.package === pkg)?.ctx
  }

  /**
   * Stop running a plugin: none of its hooks are called any more, and its api is gone.
   */
  remove(pkg: string): void {
    this.entries = this.entries.filter(e => e.loaded.package !== pkg)
    this.apis.delete(pkg)
  }

  /**
   * Ask every plugin for its `api()`, once, before any `setup()`, so a plugin can use another's api in its `setup()`
   * whatever their order. A plugin whose `api()` throws (logged) or returns undefined has none.
   */
  exposeApis(): void {
    for (const entry of this.entries) {
      const api = this.call(entry, 'api', [])
      if (api !== undefined)
        this.apis.set(entry.loaded.package, api)
    }
  }

  /** What the plugin of package `pkg` returned from `api()`. Undefined when it isn't running or has none */
  api(pkg: string): unknown {
    return this.apis.get(pkg)
  }

  private call(entry: Entry<P, C>, hook: PropertyKey, args: unknown[]): any {
    const fn = (entry.loaded.plugin as Record<PropertyKey, unknown>)[hook]
    if (typeof fn !== 'function' || entry.failed.has(hook))
      return undefined

    try {
      return fn.call(entry.loaded.plugin, ...args, entry.ctx)
    }
    catch (err) {
      entry.failed.add(hook)
      const error = err as Error
      this.logger?.error(`Plugin ${PluginHost.label(entry.loaded)} failed in ${String(hook)}(), turning that hook off: ${error?.stack ?? error}`)
      return undefined
    }
  }
}
