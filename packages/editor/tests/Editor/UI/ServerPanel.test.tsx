// @vitest-environment jsdom

import type { HttpRouteInfo } from '../../../src/Editor/Server/routesApi'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ServerPanel, { ROUTES_REFRESH_MS } from '../../../src/Editor/UI/Server/ServerPanel'

vi.mock('../../../src/Editor/UI/Server/ServerPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

const ROUTES: HttpRouteInfo[] = [
  {
    method: 'GET',
    path: '/api/game/logs',
    source: 'engine',
    params: {},
    devOnly: false,
    summary: 'Recent server log entries',
    query: { after: 'Only entries with an id above this one' },
    response: '`{ entries, latestId }`',
    auth: 'Localhost only',
  },
  { method: 'POST', path: '/api/scores/:player', source: 'game', params: { player: 'Id of the player' }, devOnly: false, summary: 'Save a score' },
  { method: 'GET', path: '/chat/history', source: 'plugin', plugin: '@acme/chat', params: {}, devOnly: true },
]

function server(routes: HttpRouteInfo[] = ROUTES) {
  return vi.fn(async () => new Response(JSON.stringify({ routes }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

/** jsdom lays nothing out, so say whether the panel's tab is the one shown */
let visible = true

beforeEach(() => {
  visible = true
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(() => visible ? document.body : null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('serverPanel', () => {
  it('lists the endpoints of the server by who registered them', async () => {
    render(<ServerPanel fetchFn={server()} />)

    await screen.findByText('HTTP endpoints (3)')
    expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Method', 'Path', 'Served in', 'From', 'What it does'])

    // The game's own first, then plugins, the engine's last
    const rows = screen.getAllByRole('row').slice(1).map(row => Array.from(row.querySelectorAll('td'), cell => cell.textContent))
    expect(rows).toEqual([
      ['POST', '/api/scores/:player', 'Prod + dev', 'Game', 'Save a score'],
      ['GET', '/chat/history', 'Dev only', '@acme/chat', ''],
      ['GET', '/api/game/logs', 'Prod + dev', 'Engine', 'Recent server log entries'],
    ])
  })

  it('marks routes that only exist in development', async () => {
    render(<ServerPanel fetchFn={server()} />)

    const environment = (path: string) => screen.getByText(path).closest('tr')!.querySelector('.environment')!
    await screen.findByText('/chat/history')

    expect(environment('/chat/history').textContent).toBe('Dev only')
    expect(environment('/chat/history').className).toContain('devOnly')
    expect(environment('/api/scores/:player').textContent).toBe('Prod + dev')
    expect(environment('/api/scores/:player').className).not.toContain('devOnly')
  })

  it('shows what a route was described with when it is opened', async () => {
    render(<ServerPanel fetchFn={server()} />)

    const header = (await screen.findByText('/api/game/logs')).closest('tr')!
    expect(screen.queryByText('Only entries with an id above this one')).toBeNull()

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('true')
    screen.getByText('after')
    screen.getByText('Only entries with an id above this one')
    screen.getByText('`{ entries, latestId }`')
    screen.getByText('Localhost only')
    expect(screen.getByText('Open in a new tab').getAttribute('href')).toBe('/api/game/logs')

    // Closes again, from the keyboard too
    fireEvent.keyDown(header, { key: 'Enter' })
    expect(screen.queryByText('Localhost only')).toBeNull()
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  it('offers no link for a route a browser can\'t just open', async () => {
    render(<ServerPanel fetchFn={server()} />)

    fireEvent.click(await screen.findByText('/api/scores/:player'))

    screen.getByText('player')
    screen.getByText('Id of the player')
    expect(screen.queryByText('Open in a new tab')).toBeNull()
  })

  it('says how to describe a route that says nothing about itself', async () => {
    render(<ServerPanel fetchFn={server()} />)

    fireEvent.click(await screen.findByText('/chat/history'))

    screen.getByText('describeRoute()')
  })

  it('shows why there is no list, and recovers on refresh', async () => {
    const fetchFn = vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    render(<ServerPanel fetchFn={fetchFn} />)

    expect((await screen.findByRole('alert')).textContent).toContain('no game server')

    fetchFn.mockImplementation(server())
    fireEvent.click(screen.getByText('Refresh'))

    await screen.findByText('HTTP endpoints (3)')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks the server only while its tab is shown, and again every few seconds', async () => {
    vi.useFakeTimers()
    visible = false
    const fetchFn = server()
    render(<ServerPanel fetchFn={fetchFn} />)

    await act(() => vi.advanceTimersByTimeAsync(ROUTES_REFRESH_MS * 2))
    expect(fetchFn).not.toHaveBeenCalled()

    // Its tab is opened
    visible = true
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(ROUTES_REFRESH_MS))
    expect(fetchFn).toHaveBeenCalledTimes(2)

    // A route added while the editor is open shows up
    fetchFn.mockImplementation(server([...ROUTES, { method: 'DELETE', path: '/api/scores', source: 'game', params: {}, devOnly: false }]))
    await act(() => vi.advanceTimersByTimeAsync(ROUTES_REFRESH_MS))
    vi.useRealTimers()
    await waitFor(() => screen.getByText('HTTP endpoints (4)'))
  })
})
