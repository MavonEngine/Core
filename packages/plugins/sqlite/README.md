# @mavonengine/sqlite

A [MavonEngine](https://mavonengine.com) plugin that gives the game server and its plugins a SQLite database. It uses Node's built-in `node:sqlite`, so there is nothing native to compile, and [Kysely](https://kysely.dev) to build the queries.

```sh
npx @mavonengine/cli install @mavonengine/sqlite
```

The database is created at `.mavonengine/data/mavonengine.sqlite` in the project when the server starts. Projects made with `mavonengine create` ignore `.mavonengine/` in git; add it to your `.gitignore` if your project predates that.

Without a database plugin, the server has no database: `ctx.db` and `server.db` are undefined and plugins run without one. Nothing database-related is installed until you add a database plugin.

## Options

Set in `mavonengine.json` under `plugins["@mavonengine/sqlite"].options`:

| Option | Default | |
| --- | --- | --- |
| `path` | `.mavonengine/data/mavonengine.sqlite` | The database file, relative to the project root. `:memory:` keeps it in memory, gone when the server stops |
| `busyTimeoutMs` | `5000` | How long a query waits for another connection's lock before it fails |

`MAVONENGINE_SQLITE_PATH` overrides `path`, for example to keep the database on a volume in production.

The database runs in WAL mode with foreign keys on.

## Using the database in a plugin

Every server plugin gets the database as `ctx.db`, a Kysely instance. Name your tables with `ctx.table()`, which prefixes them with your package name (`@acme/shop` → `acme_shop_items`) so plugins' tables don't clash. Create them with `migrations`, which the engine runs before `setup()`:

```ts
import type { ServerPlugin } from '@mavonengine/core/Plugins/types'

export default {
  migrations: {
    '001_init': {
      async up(db, { table }) {
        await db.schema.createTable(table('scores'))
          .addColumn('player', 'text', c => c.primaryKey())
          .addColumn('score', 'integer', c => c.notNull().defaultTo(0))
          .execute()
      },
    },
  },

  http(app, ctx) {
    app.get('/api/leaderboard', async (_req, res) => {
      if (!ctx.db)
        return res.status(503).json({ error: 'No database' })

      res.json(await ctx.db.selectFrom(ctx.table('scores')).selectAll().orderBy('score', 'desc').limit(10).execute())
    })
  },
} satisfies ServerPlugin
```

- **Migrations:**
  - They run in the order of their names, once per database. Name them so they sort, like `001_init` and `002_add_reason`.
  - Never change or rename a migration that has shipped; add a new one instead.
  - Each migration runs in a transaction. One that fails is rolled back and turns the plugin off until the next start.
- **No database:** `ctx.db` is undefined when the project has no database plugin. Check for it, and keep working without the database if your plugin can.
- **Shared instance:** don't destroy `ctx.db`, since all plugins share it. The engine closes it when the server stops, after every plugin's `destroy()` has finished. A plugin can still save from an async `destroy()`.
- **Portable SQL:** stick to SQL that works across databases, so your plugin also runs on database plugins other than SQLite. SQLite stores booleans as `0`/`1` and dates as ISO strings, and reads them back as those values.
- **Kysely:** add `kysely` as a dev dependency for its types and for `sql`.

The game's own server code gets the same database as `server.db`, after `await server.start()`. Name its tables so they don't start with a plugin's prefix, e.g. `game_scores`.

## More than one database plugin

When more than one database plugin is enabled, name the one to use in `mavonengine.json`:

```json
{
  "database": "@mavonengine/sqlite",
  "plugins": { "@mavonengine/sqlite": {} }
}
```

## Outside a game server

For scripts and tests, `openSqlite(path)` opens a database the same way:

```ts
import { openSqlite } from '@mavonengine/sqlite'

const db = openSqlite('.mavonengine/data/mavonengine.sqlite')
const mutes = await db.selectFrom('chat_mutes').selectAll().execute()
await db.destroy()
```
