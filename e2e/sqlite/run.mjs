/**
 * End-to-end test for @mavonengine/sqlite, run against packages/multiplayer-template with the built plugin:
 *
 * 1. with the sqlite plugin and e2e/sqlite/visits-plugin, a plugin with a migration that adds a row on every start:
 *    the server opens the database file, runs the migration, and the plugin reads and writes through ctx.db.
 *    GET /api/game/plugins marks the database plugin, GET /api/game/database lists the plugin's table
 * 2. stopped with SIGTERM and started again: the plugin saved on the way out (not on Windows, which has no SIGTERM),
 *    the rows are still there, and the migration doesn't run a second time
 *    `mavonengine mcp` reads the same through database_overview and database_rows, as an AI assistant would
 * 3. without the sqlite plugin: the server warns, runs the plugin without a database and has none to show
 *
 * Needs core, the CLI and the sqlite plugin built and the template's dependencies installed.
 * The database goes to a temporary directory. The template is restored afterwards, also on failure.
 *
 *   node e2e/sqlite/run.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { base, check, cli, isWindows, linkIntoTemplate, log, PORT, repo, run, snapshotFiles, startServer, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SQLITE = '@mavonengine/sqlite'
const VISITS = 'e2e-visits'
const TABLE = 'e2e_visits_log'

const json = async path => (await fetch(`${base}${path}`)).json()

/** The plugin adds its row in setup(), which the server doesn't wait for: give it a moment */
async function visitsReach(count) {
  const deadline = Date.now() + 5000
  let visits
  while (Date.now() < deadline) {
    visits = await json('/api/visits')
    if (visits.count >= count)
      break
    await delay(100)
  }
  return visits
}

async function main() {
  const configPath = join(template, 'mavonengine.json')
  const restore = snapshotFiles([configPath])
  const dataDir = mkdtempSync(join(tmpdir(), 'mavonengine-sqlite-e2e-'))
  const dbPath = join(dataDir, 'e2e.sqlite')
  const links = []
  let server

  const configure = (plugins) => {
    writeFileSync(configPath, `${JSON.stringify({ plugins }, null, 2)}\n`)
  }
  const withDatabase = { [SQLITE]: { options: { path: dbPath } }, [VISITS]: {} }

  try {
    log('\n== setup')
    links.push(linkIntoTemplate(SQLITE, join(repo, 'packages/plugins/sqlite')))
    links.push(linkIntoTemplate(VISITS, join(here, 'visits-plugin')))
    configure(withDatabase)
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })

    log('\n== first start')
    server = await startServer({ LOG_LEVEL: 'debug' })
    // The built plugin, loaded the way a project loads it: catches a build that breaks the node:sqlite import
    check(server.output().includes(`Database: SQLite (${SQLITE})`), 'the server uses the sqlite plugin\'s database')
    check(server.output().includes(`Plugin Visits (${VISITS}): ran migrations 001_init`), 'the plugin\'s migration runs')
    check(existsSync(dbPath), 'the database file is created where the options say')
    check((await visitsReach(1)).count === 1, 'the plugin writes and reads through ctx.db')

    const plugins = (await json('/api/game/plugins')).plugins
    check(plugins.find(p => p.package === SQLITE)?.database === true, 'GET /api/game/plugins marks the database plugin')
    check(!plugins.find(p => p.package === VISITS)?.database, 'and only that one')

    const database = await json('/api/game/database')
    check(database.provider === SQLITE, 'GET /api/game/database names the database plugin')
    const table = database.tables.find(t => t.name === TABLE)
    check(table?.plugin === VISITS && table.rows === 1, 'it lists the plugin\'s table with its rows')
    check(database.migrations.some(m => m.plugin === VISITS && m.applied.some(a => a.name === '001_init')), 'and the migration that ran')
    check((await json(`/api/game/database/tables/${TABLE}`)).total === 1, 'GET /api/game/database/tables/:name pages the rows')

    // What an AI assistant sees: the CLI's MCP server reading the same database
    const mcp = new Client({ name: 'e2e', version: '0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--port', String(PORT), '--no-docs', '--no-plugin-list'], stderr: 'ignore' }))
    try {
      const tool = async (name, args = {}) => JSON.parse((await mcp.callTool({ name, arguments: args })).content[0].text)
      const overview = await tool('database_overview')
      check(overview.provider === SQLITE && overview.tables.some(t => t.name === TABLE && t.plugin === VISITS), 'mcp database_overview lists the plugin\'s table')
      const rows = await tool('database_rows', { table: TABLE })
      check(rows.total === 1 && rows.rows.length === 1 && typeof rows.rows[0].at === 'string', 'mcp database_rows reads its rows')
    }
    finally {
      await mcp.close()
    }
    // SIGTERM, except on Windows, where killing a process ends it without a signal
    await server.stop()
    if (!isWindows)
      check(server.output().includes('SIGTERM: stopping the server'), 'SIGTERM stops the server gracefully')
    server = undefined

    log('\n== stopped and started again')
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(!server.output().includes('ran migrations'), 'the migration doesn\'t run again')
    // The row of the first start, the one its destroy() saved on the way out, and the one of this start
    const expected = isWindows ? 2 : 3
    check((await visitsReach(expected)).count === expected, isWindows ? 'the row from before the restart is still there' : 'the rows from before the restart are there, also the one saved on shutdown')
    await server.stop()
    server = undefined

    log('\n== without the sqlite plugin')
    configure({ [VISITS]: {} })
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(server.output().includes(`Plugin Visits (${VISITS}) has database migrations, but the project has no database plugin`), 'the server warns that the plugin has no database')
    check((await json('/api/visits')).database === false, 'the plugin runs without a database')
    check(!(await json('/api/game/plugins')).plugins.some(p => p.database), 'no plugin is marked as the database plugin')
    check((await json('/api/game/database')).provider === null, 'GET /api/game/database says there is none')

    log('\nsqlite e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await server?.stop()
    restore()
    for (const link of links)
      rmSync(link, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nsqlite e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
