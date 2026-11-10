import type { ServerChannel } from '@geckos.io/server'
import type { Express } from 'express'
import type winston from 'winston'
import type BaseGame from '../BaseGame'
import type Game from '../Game'
import type Server from '../Networking/Server/Server'
import type { PrefabDefinition } from '../Prefab/PrefabRegistry'
import type { SceneObjectDefinition } from '../Scene/SceneObjectRegistry'
import type { Asset } from '../Types/Asset'
import type IEditor from '../Types/IEditor'
import type Logger from '../Utils/Logger'
import type GameObject from '../World/GameObject'

/** Where a plugin runs, declared as `mavonengine.target` in its package.json */
export type PluginTarget = 'client' | 'server' | 'both'

export type PluginOptions = Record<string, unknown>

interface PluginContextBase<TGame extends BaseGame> {
  /** npm package name of the plugin */
  readonly package: string
  /** `plugins.<package>.options` from mavonengine.json */
  readonly options: PluginOptions
  readonly game: TGame
  readonly logger: winston.Logger | Logger | null | undefined
  /**
   * Make a scene object type loadable on this side. Its key in scene files is `<package>:<type>`, which is returned.
   * Register the same type in the plugin's client and server entries to build it on both.
   */
  registerSceneObject<T extends GameObject>(definition: Omit<SceneObjectDefinition<T>, 'plugin'>): string
}

export interface ClientPluginContext extends PluginContextBase<Game> {
  /**
   * URL of a file in the plugin's assets directory, e.g. `assetUrl('models/tree.glb')` → `/plugins/<package>/models/tree.glb`.
   */
  assetUrl(path: string): string
  /** Make a prefab available in the editor's Prefabs tab */
  registerPrefab(prefab: Omit<PrefabDefinition, 'plugin'>): void
  /** The editor, once it has booted (dev only) */
  readonly editor?: IEditor
}

export interface EditorPluginContext extends ClientPluginContext {
  readonly editor: IEditor
}

export interface ServerPluginContext extends PluginContextBase<BaseGame> {
  readonly server: Server<GameObject>
  /** Directory with mavonengine.json, when the plugins were loaded from it */
  readonly projectRoot?: string
}

interface PluginBase<TContext> {
  /** Shown in logs. Defaults to the package name */
  name?: string
  /** Called once when the game (client) or server starts */
  setup?(ctx: TContext): void
}

/**
 * The default export of a plugin's client entry.
 */
export interface ClientPlugin extends PluginBase<ClientPluginContext> {
  /**
   * Resources to load with the game. Use `ctx.assetUrl()` for files the plugin ships.
   * In a release, assets of prefabs the project doesn't use are left out automatically.
   */
  assets?(ctx: ClientPluginContext): Asset[]
  /** Called every frame */
  update?(delta: number, ctx: ClientPluginContext): void
  /** Called when the editor boots (dev only) */
  editor?(ctx: EditorPluginContext): void
}

/**
 * The default export of a plugin's server entry.
 */
export interface ServerPlugin extends PluginBase<ServerPluginContext> {
  /**
   * Register HTTP routes. Runs after the server's own `onHttp` routes and before the game client,
   * so plugin routes take precedence over the client's page fallback.
   */
  http?(app: Express, ctx: ServerPluginContext): void
  /** A client connected and was added to the world */
  onConnection?(channel: ServerChannel, client: GameObject, ctx: ServerPluginContext): void
  /** A client disconnected */
  onDisconnect?(channel: ServerChannel, ctx: ServerPluginContext): void
  /** Called every server tick, after the server's own `onTick` */
  tick?(delta: number, ctx: ServerPluginContext): void
  /** Called when the server stops */
  destroy?(ctx: ServerPluginContext): void
}

/**
 * A plugin together with where it came from, as produced by the loaders.
 */
export interface LoadedPlugin<TPlugin> {
  package: string
  options: PluginOptions
  plugin: TPlugin
  /**
   * Asset paths (relative to the plugin's assets directory) that are part of the release.
   * Undefined in dev, where every asset is served.
   */
  shippedAssets?: string[]
}

export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin
}

export function defineServerPlugin(plugin: ServerPlugin): ServerPlugin {
  return plugin
}

/** URL prefix plugin assets are served and shipped under */
export function pluginAssetBase(pkg: string): string {
  return `/plugins/${pkg}/`
}

/** Dev only: the editor posts `{ plugin, prefab }` here when it places a plugin prefab, see `mavonEnginePlugins()` */
export const PREFAB_USED_PATH = '/__mavonengine/prefab-used'

/** Dev only: GET lists the plugins in mavonengine.json with their version and readme, for the editor's Plugins view */
export const PLUGINS_INFO_PATH = '/__mavonengine/plugins'

/**
 * A plugin listed in the project's mavonengine.json, as the dev server describes it on `PLUGINS_INFO_PATH`
 */
export interface PluginInfo {
  /** npm package name */
  package: string
  /** Not turned off with `enabled: false` in mavonengine.json */
  enabled: boolean
  /** Found in node_modules with a valid `mavonengine` field in its package.json */
  installed: boolean
  /** Why it can't be used, when it isn't installed or its manifest is invalid */
  problem?: string
  version?: string
  description?: string
  license?: string
  homepage?: string
  target?: PluginTarget
  /** Supported @mavonengine/core versions, a semver range */
  engine?: string
  /** Its README as Markdown, cut off when it is very long */
  readme?: string
  /** Prefabs its manifest ships assets for */
  declaredPrefabs: string[]
  /** Prefabs the project uses, from `prefabs` in mavonengine.json: their assets ship in a release */
  usedPrefabs: string[]
}

export interface PluginInfoList {
  /** Directory with mavonengine.json, null when the project has none */
  root: string | null
  plugins: PluginInfo[]
}

/** Dev server endpoint the editor saves scenes to: POST { name, scene } */
export const SCENE_SAVE_PATH = '/__mavonengine/scene-save'
