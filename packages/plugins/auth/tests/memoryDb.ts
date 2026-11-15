import { DatabaseSync } from 'node:sqlite'
import { Kysely, SqliteDialect } from 'kysely'

/** A Kysely on an in-memory node:sqlite database, the way @mavonengine/sqlite builds one */
export function memoryDb(): Kysely<any> {
  const raw = new DatabaseSync(':memory:')
  return new Kysely({
    dialect: new SqliteDialect({
      database: {
        close: () => raw.close(),
        prepare(sql) {
          const statement = raw.prepare(sql)
          return {
            reader: statement.columns().length > 0,
            all: parameters => statement.all(...(parameters as any[])),
            run: parameters => statement.run(...(parameters as any[])),
            iterate: parameters => statement.iterate(...(parameters as any[])),
          }
        },
      },
    }),
  })
}
