import type { ServerChannel } from '@geckos.io/server'
import type { Express, RequestHandler } from 'express'
import type { Kysely } from 'kysely'
import type { IncomingMessage } from 'node:http'
import type winston from 'winston'
import type BaseGame from '../BaseGame'
import type Game from '../Game'
import type { AuthorizeResult, Identity } from '../Networking/identity'
import type Server from '../Networking/Server/Server'
import type { PrefabDefinition } from '../Prefab/PrefabRegistry'
import type { SceneObjectDefinition } from '../Scene/SceneObjectRegistry'
import type { Asset } from '../Types/Asset'
import type IEditor from '../Types/IEditor'
import type Logger from '../Utils/Logger'
import type GameObject from '../World/GameObject'
import type { PluginMigration } from './Database/migrate'

export type { AuthorizeResult, Identity } from '../Networking/identity'
export type { MigrationTools, PluginMigration } from './Database/migrate'

/** Where a plugin runs, declared as `mavonengine.target` in its package.json */
export type PluginTarget = 'client' | 'server' | 'both'

export type PluginOptions = Record<string, unknown>

/**
 * The server's admin token, without telling what it is: for a plugin that takes it some other way than
 * `requireAdmin` does, like as the password of a login
 */
export interface AdminToken {
  /** Whether the server has one. Without, `requireAdmin` only lets requests from localhost through */
  readonly configured: boolean
  /** Whether `candidate` is the token. Always false without one */
  matches(candidate: string): boolean
}

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
  /**
   * The project's copy of a file this plugin publishes (see `publish` in its manifest), e.g. `publishedFile('layout.html')`,
   * once the project ran `mavonengine asset:publish <package>`. Undefined when it has none, so the plugin uses its own
   */
  publishedFile(path: string): string | undefined
  /**
   * Guard for the plugin's admin routes: `app.post('/api/my-plugin/reset', ctx.requireAdmin, handler)`.
   * It asks for the server's admin token (`adminToken` in its options, or MAVONENGINE_ADMIN_TOKEN) as
   * `Authorization: Bearer <token>`, and without one only lets requests from localhost through.
   * Use it instead of a token of the plugin's own, so one token administers the whole server.
   */
  readonly requireAdmin: RequestHandler
  /** The same token for a plugin that checks it itself, e.g. as a password. Prefer `requireAdmin` for routes */
  readonly adminToken: AdminToken
  /**
   * The server's database, a Kysely instance (https://kysely.dev), or undefined when the project has no database
   * plugin such as `@mavonengine/sqlite`. Ready in `setup()`, after the plugin's `migrations` ran.
   * Keep to the plugin's own tables, named with `table()`. Shared by all plugins: don't destroy it.
   */
  readonly db: Kysely<any> | undefined
  /** The plugin's name for one of its tables, e.g. `table('mutes')` → `chat_mutes`, so plugins' tables don't clash */
  table(name: string): string
  /**
   * Who is on the other end of `channel`, as the project's auth plugin said when it connected. Undefined without an
   * auth plugin, and for a client it let in without one. Key what lasts beyond a connection on `identity.id`, not
   * `channel.id`, which changes on every reconnect.
   */
  identity(channel: ServerChannel): Identity | undefined
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
  /**
   * What to send as the `Authorization` header when the game connects, e.g. `Bearer <session token>`, for the auth
   * plugin on the server to check. Asked each time a `NetworkManager` is made, unless the game passes its own
   * `authorization`; the first plugin that returns a string is used. Return undefined to send none.
   */
  authorization?(ctx: ClientPluginContext): string | undefined
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
  /**
   * Called when the server stops. The database is closed once the promises returned here settled,
   * so a plugin can still save what it has
   */
  destroy?(ctx: ServerPluginContext): void | Promise<void>
  /**
   * Schema changes for the plugin's tables, by name. They run in the order of their names, each once per database,
   * before `setup()`: name them so they sort, like `001_init`, `002_add_reason`. Never change or rename one that
   * shipped; add a new one. Skipped when the project has no database plugin.
   */
  migrations?: Record<string, PluginMigration>
  /**
   * Makes this a database plugin: return the Kysely instance the server and its plugins use. Called once, before
   * any plugin's migrations and `setup()`, and only for the plugin the project picked (see `database` in
   * mavonengine.json). The engine destroys the instance when the server stops, after every plugin's `destroy()`.
   */
  database?(ctx: ServerPluginContext): Kysely<any> | undefined
  /**
   * Makes this an auth plugin: decide whether a client may connect, before it gets a player. `authorization` is the
   * `Authorization` header the client sent (see the client plugin's `authorization()`), undefined when it sent none.
   * Return:
   * - an `Identity`, to let it in as that account: `ctx.identity(channel)` and `player.identity` give it back.
   *   It is also sent to the client, so keep it to what the player may see
   * - `true`, to let it in without an identity, e.g. as a guest
   * - `false`, to turn it away with 401, or an HTTP status from 400 to 599, e.g. 403 for a banned account
   *
   * Only the plugin the project picked is asked (see `auth` in mavonengine.json). A throw or a result that is none of
   * the above turns that client away with 500 and is logged. When the project has an auth plugin that doesn't run,
   * e.g. because its migrations failed, every client is turned away with 503 rather than let in unchecked.
   */
  authorize?(authorization: string | undefined, request: IncomingMessage, ctx: ServerPluginContext): AuthorizeResult | Promise<AuthorizeResult>
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

/**
 * A plugin as the game server lists it on GET /api/game/plugins. Without the readme, which only the dev server sends
 */
export interface ServerPluginInfo extends Omit<PluginInfo, 'readme'> {
  /** Its server entry was loaded by this server and is running */
  runningOnServer: boolean
  /** Set on the database plugin the server uses */
  database?: true
  /** Set on the auth plugin the server uses */
  auth?: true
}

export interface ServerPluginList {
  plugins: ServerPluginInfo[]
}

export interface PluginInfoList {
  /** Directory with mavonengine.json, null when the project has none */
  root: string | null
  plugins: PluginInfo[]
}

/** Dev server endpoint the editor saves scenes to: POST { name, scene } */
export const SCENE_SAVE_PATH = '/__mavonengine/scene-save'
