/**
 * What a route says about itself, given to `describeRoute()`. Everything is optional:
 * a route without any is still listed with its method, path and where it comes from.
 */
export interface HttpRouteDoc {
  /** One line, shown in lists */
  summary?: string
  /** Anything longer */
  description?: string
  /** Path parameters by name, e.g. `{ id: 'Id of the entity' }` for `/entities/:id` */
  params?: Record<string, string>
  /** Query parameters by name */
  query?: Record<string, string>
  /** What it answers with */
  response?: string
  /** Who may call it */
  auth?: string
  /**
   * Say so when the route is only registered in development, like `if (NODE_ENV !== 'production') app.get(…)`.
   * A route that doesn't say counts as served in production too: nothing can tell from the route itself.
   */
  devOnly?: boolean
}

/** Who registered a route: the engine itself, the game's server (`onHttp`) or a plugin */
export type HttpRouteSource = 'engine' | 'game' | 'plugin'

/**
 * One HTTP endpoint of the game server, as GET /api/game/routes lists it
 */
export interface HttpRouteInfo extends HttpRouteDoc {
  /** Upper case, `ALL` for a route that answers every method */
  method: string
  path: string
  source: HttpRouteSource
  /** npm package of the plugin, when `source` is `plugin` */
  plugin?: string
  /** Every parameter in the path, with its description when the route gave one, else an empty string */
  params: Record<string, string>
  /** True for a route that only exists in development, false for one that is served in production too */
  devOnly: boolean
}

export interface HttpRouteList {
  routes: HttpRouteInfo[]
}
