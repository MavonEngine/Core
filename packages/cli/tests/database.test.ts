import type { DashboardState, MetricsSource } from '../src/dashboard/MetricsClient'
import type { ViewState } from '../src/dashboard/view'
import { renderToScreen } from '@profullstack/hqtui'
import { describe, expect, it, vi } from 'vitest'
import MetricsClient, { MetricsSourceError } from '../src/dashboard/MetricsClient'
import { simulatedSource } from '../src/dashboard/simulator'
import { normalizeDatabase, normalizeTablePage } from '../src/dashboard/snapshot'
import { dashboardTabs, formatCell, handleDatabaseKey, initialViewState, renderDashboard, selectedTable, showsDatabase, tabForKey } from '../src/dashboard/view'

const DATABASE_TAB = 7

function source(overrides: Partial<MetricsSource> = {}): MetricsSource {
  const sim = simulatedSource()
  return {
    ...sim,
    fetchDatabase: vi.fn(sim.fetchDatabase!),
    fetchTable: vi.fn(sim.fetchTable!),
    ...overrides,
  }
}

function view(overrides: Partial<ViewState> = {}): ViewState {
  return {
    ...initialViewState(),
    tab: DATABASE_TAB,
    ...overrides,
  }
}

async function liveState(src = source()): Promise<{ state: DashboardState, client: MetricsClient }> {
  const client = new MetricsClient(src)
  client.watchDatabase = true
  await client.poll()
  return { state: client.state, client }
}

function render(state: DashboardState, v = view(), width = 130, height = 40) {
  return renderToScreen(({ ui, theme }) => renderDashboard(ui, theme, state, v), { width, height })
}

describe('database in the dashboard client', () => {
  it('only reads the database while asked to, and not on every poll', async () => {
    const src = source()
    const client = new MetricsClient(src, { routesIntervalMs: 60_000 })

    await client.poll()
    expect(src.fetchDatabase).not.toHaveBeenCalled()

    client.watchDatabase = true
    await client.poll()
    await client.poll()
    expect(src.fetchDatabase).toHaveBeenCalledTimes(1)
    expect(client.state.database?.provider).toBe('@mavonengine/sqlite')
    expect(client.state.databaseAvailable).toBe(true)

    await client.refresh()
    expect(src.fetchDatabase).toHaveBeenCalledTimes(2)
    client.stop()
  })

  it('tells that the database needs the admin token, and keeps the rest of the dashboard live', async () => {
    const fetchDatabase = async () => {
      throw new MetricsSourceError('Metrics token missing or wrong (use --token)', 'unauthorized')
    }
    const { state } = await liveState(source({ fetchDatabase }))

    expect(state.status).toBe('live')
    expect(state.databaseError).toContain('admin token')
    expect(state.databaseAvailable).toBeNull()
  })

  it('stops asking a server that has no database endpoint', async () => {
    const fetchDatabase = vi.fn(async () => {
      throw new MetricsSourceError('not found', 'disabled')
    })
    const { state, client } = await liveState(source({ fetchDatabase }))
    expect(state.databaseAvailable).toBe(false)

    await client.refresh()
    expect(fetchDatabase).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it('loads pages of a table, ignoring one that arrives after another was opened', async () => {
    let release = () => {}
    const slow = new Promise<void>(resolve => (release = resolve))
    const sim = simulatedSource()
    const fetchTable = vi.fn(async (name: string, offset: number, limit: number) => {
      if (offset === 0)
        await slow
      return sim.fetchTable!(name, offset, limit)
    })
    const client = new MetricsClient(source({ fetchTable }))

    const first = client.inspectTable('chat_messages', 0)
    expect(client.state.tableDetail).toMatchObject({ table: 'chat_messages', offset: 0, status: 'loading' })
    await client.inspectTable('chat_messages', 50)
    release()
    await first

    expect(client.state.tableDetail).toMatchObject({ table: 'chat_messages', offset: 50, status: 'ready' })
    expect(client.state.tableDetail!.page!.rows[0]).toMatchObject({ id: 51 })

    await client.inspectTable('gone')
    expect(client.state.tableDetail).toMatchObject({ status: 'error', error: 'The database has no table gone (any more)' })

    await client.inspectTable(null)
    expect(client.state.tableDetail).toBeNull()
  })
})

describe('database responses', () => {
  it('reads what the server sends, whatever is missing', () => {
    expect(normalizeDatabase(null)).toEqual({ provider: null, tables: [], migrations: [] })
    expect(normalizeDatabase({
      provider: 'x',
      tables: [
        {
          name: 't',
          rows: 'many',
          columns: [
            { name: 'a' },
          ],
        },
      ],
      migrations: [
        {
          table: 'p__migrations',
          applied: [
            { name: '001' },
          ],
        },
      ],
    })).toEqual({
      provider: 'x',
      tables: [
        {
          name: 't',
          plugin: null,
          rows: null,
          columns: [
            {
              name: 'a',
              type: '',
              nullable: true,
              autoIncrement: false,
              hasDefault: false,
            },
          ],
        },
      ],
      migrations: [
        {
          plugin: null,
          table: 'p__migrations',
          applied: [
            { name: '001', executedAt: null },
          ],
        },
      ],
    })
    expect(normalizeTablePage({
      table: 't',
      rows: [
        { a: 1 },
        'junk',
      ],
    })).toEqual({
      table: 't',
      columns: [],
      rows: [
        { a: 1 },
      ],
      total: 1,
      offset: 0,
      limit: 1,
    })
  })
})

describe('database tab', () => {
  it('only shows up while the server has a database plugin', async () => {
    const { state } = await liveState()
    expect(dashboardTabs(state)).toContain('Database')
    expect(tabForKey('8', dashboardTabs(state).length)).toBe(7)

    const without = {
      ...state,
      plugins: state.plugins.map(({ database: _database, ...plugin }) => plugin),
    }
    expect(dashboardTabs(without)).not.toContain('Database')
    expect(tabForKey('8', dashboardTabs(without).length)).toBeNull()
    expect(tabForKey('7', dashboardTabs(without).length)).toBe(6)

    const v = view()
    const screen = render(without, v)
    expect(screen.contains('8 Database')).toBe(false)
    expect(screen.contains('1-7 Tabs')).toBe(true)
    // The tab it was on went away: back to the overview
    expect(v.tab).toBe(0)
  })

  it('lists the tables with their plugin and rows, and shows the rows of the first', async () => {
    const { state, client } = await liveState()
    await client.inspectTable('chat_messages', 0)

    const screen = render(state)

    for (const text of [
      '8 Database',
      'Tables in @mavonengine/sqlite (2)',
      'chat_messages',
      '@mavonengine/chat',
      'game_scores',
      'game',
      '137',
      'chat_messages · rows 1–',
      'anyone near the tower?',
      'Migrations',
      '001_init',
      '←→ Page rows',
    ])
      expect(screen.contains(text), text).toBe(true)
  })

  it('shows the rows of the picked table, with NULL for missing values', async () => {
    const { state, client } = await liveState()
    await client.inspectTable('game_scores', 0)

    const screen = render(state, view({ selectedTable: 'game_scores' }))

    expect(screen.contains('game_scores · rows 1–3 of 3')).toBe(true)
    expect(screen.contains('Wolves')).toBe(true)
    expect(screen.contains('NULL')).toBe(true)
  })

  it('says why there is nothing to show', async () => {
    const base = (await liveState()).state

    expect(render({ ...base, database: null, databaseError: 'The database needs the server\'s admin token: start the dashboard with --token <admin token>' }).contains('needs the server\'s admin token')).toBe(true)
    expect(render({
      ...base,
      database: { provider: null, tables: [], migrations: [] },
    }).contains('mavonengine install @mavonengine/sqlite')).toBe(true)
    expect(render({
      ...base,
      database: { provider: '@mavonengine/sqlite', tables: [], migrations: [] },
    }).contains('No tables yet')).toBe(true)
    expect(render({ ...base, database: null, databaseAvailable: false }).contains('without GET /api/game/database')).toBe(true)
  })

  it('picks tables with the arrow keys and pages through rows with left and right', async () => {
    const { state } = await liveState()
    const v = view()

    expect(showsDatabase(v)).toBe(true)
    expect(selectedTable(v, state.database)?.name).toBe('chat_messages')

    // By as many rows as fit, 20 before the rows were drawn
    expect(handleDatabaseKey(v, state.database, 'right')).toBe(true)
    expect(v.tableOffset).toBe(20)
    v.tableVisibleRows = 50
    expect(handleDatabaseKey(v, state.database, 'pagedown')).toBe(true)
    expect(v.tableOffset).toBe(70)
    // 137 rows: the last page shows the last 50
    expect(handleDatabaseKey(v, state.database, 'right')).toBe(true)
    expect(v.tableOffset).toBe(87)
    expect(handleDatabaseKey(v, state.database, 'right')).toBe(false)
    expect(handleDatabaseKey(v, state.database, 'left')).toBe(true)
    expect(v.tableOffset).toBe(37)

    expect(handleDatabaseKey(v, state.database, 'down')).toBe(true)
    expect(v).toMatchObject({ selectedTable: 'game_scores', tableOffset: 0 })
    expect(handleDatabaseKey(v, state.database, 'down')).toBe(false)
    expect(handleDatabaseKey(v, state.database, 'k')).toBe(true)
    expect(v.selectedTable).toBe('chat_messages')

    expect(handleDatabaseKey(view({ tab: 0 }), state.database, 'down')).toBe(false)
    expect(handleDatabaseKey(v, null, 'down')).toBe(false)
  })

  it('shows any value as a short cell', () => {
    expect(formatCell(null)).toBe('NULL')
    expect(formatCell(undefined)).toBe('NULL')
    expect(formatCell(42)).toBe('42')
    expect(formatCell({
      a: [1],
    })).toBe('{"a":[1]}')
    expect(formatCell('two\nlines')).toBe('two ⏎ lines')
    expect(formatCell('x'.repeat(100))).toHaveLength(60)
  })
})
