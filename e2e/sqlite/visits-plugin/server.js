/**
 * Uses the server's database the way a plugin would: a migration creates its table,
 * every start adds a row, so does every graceful stop, and GET /api/visits counts them.
 */
export default {
  name: 'Visits',
  migrations: {
    '001_init': {
      async up(db, { table }) {
        await db.schema.createTable(table('log'))
          .addColumn('id', 'integer', c => c.primaryKey().autoIncrement())
          .addColumn('at', 'text', c => c.notNull())
          .execute()
      },
    },
  },
  async setup(ctx) {
    if (ctx.db)
      await ctx.db.insertInto(ctx.table('log')).values({ at: new Date().toISOString() }).execute()
  },
  async destroy(ctx) {
    if (ctx.db)
      await ctx.db.insertInto(ctx.table('log')).values({ at: 'shutdown' }).execute()
  },
  http(app, ctx) {
    app.get('/api/visits', async (_req, res) => {
      if (!ctx.db)
        return res.json({ database: false })
      const rows = await ctx.db.selectFrom(ctx.table('log')).selectAll().execute()
      res.json({ database: true, count: rows.length })
    })
  },
}
