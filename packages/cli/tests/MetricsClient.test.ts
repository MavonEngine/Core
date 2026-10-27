import { afterEach, describe, expect, it, vi } from 'vitest'
import MetricsClient, { httpSource, MAX_LOG_LINES, MetricsSourceError } from '../src/dashboard/MetricsClient'

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('httpSource', () => {
  it('sends the token as a bearer header', async () => {
    const fetch = vi.fn(async () => response(200, { uptime: 1 }))
    const source = httpSource({ url: 'http://localhost:8050/api/game/metrics', token: 'secret', fetch })

    expect(await source.fetch()).toEqual({ uptime: 1 })
    expect(fetch).toHaveBeenCalledWith('http://localhost:8050/api/game/metrics', expect.objectContaining({
      headers: { Authorization: 'Bearer secret' },
    }))
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'disabled'],
    [500, 'unreachable'],
  ])('maps HTTP %i to %s', async (status, expected) => {
    const source = httpSource({ url: 'http://x.test', fetch: async () => response(status) })

    await expect(source.fetch()).rejects.toMatchObject({ status: expected })
  })

  it('reports network errors as unreachable', async () => {
    const source = httpSource({
      url: 'http://x.test',
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    await expect(source.fetch()).rejects.toMatchObject({ status: 'unreachable', message: expect.stringContaining('ECONNREFUSED') })
  })
})

describe('metricsClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes live after a successful poll', async () => {
    const client = new MetricsClient({ label: 'test', fetch: async () => ({ uptime: 42 }) })
    const listener = vi.fn()
    client.onChange(listener)

    expect(client.state.status).toBe('connecting')

    await client.poll()

    expect(client.state.status).toBe('live')
    expect(client.state.snapshot?.uptime).toBe(42)
    expect(client.state.lastUpdate).not.toBeNull()
    expect(listener).toHaveBeenCalledWith(client.state)
  })

  it('keeps the last snapshot when a poll fails', async () => {
    let fail = false
    const client = new MetricsClient({
      label: 'test',
      fetch: async () => {
        if (fail)
          throw new MetricsSourceError('gone', 'unreachable')
        return { uptime: 1 }
      },
    })

    await client.poll()
    fail = true
    await client.poll()

    expect(client.state.status).toBe('unreachable')
    expect(client.state.error).toBe('gone')
    expect(client.state.failures).toBe(1)
    expect(client.state.snapshot?.uptime).toBe(1)

    fail = false
    await client.poll()

    expect(client.state.status).toBe('live')
    expect(client.state.error).toBeNull()
    expect(client.state.failures).toBe(0)
  })

  it('backs off exponentially while failing, up to the max', async () => {
    const client = new MetricsClient(
      { label: 'test', fetch: async () => { throw new Error('nope') } },
      { intervalMs: 1000, maxBackoffMs: 5000 },
    )

    expect(client.nextDelay()).toBe(1000)
    await client.poll()
    expect(client.nextDelay()).toBe(2000)
    await client.poll()
    expect(client.nextDelay()).toBe(4000)
    await client.poll()
    expect(client.nextDelay()).toBe(5000)
  })

  it('polls quickly without backoff until a starting server first answers', async () => {
    let up = false
    const client = new MetricsClient(
      { label: 'test', fetch: async () => {
        if (!up)
          throw new Error('nope')
        return {}
      } },
      { intervalMs: 1000, startupIntervalMs: 250 },
    )

    await client.poll()
    await client.poll()
    expect(client.nextDelay()).toBe(250)

    up = true
    await client.poll()
    expect(client.nextDelay()).toBe(1000)

    up = false
    await client.poll()
    expect(client.nextDelay()).toBe(2000)
  })

  it('polls on an interval until stopped', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => ({}))
    const client = new MetricsClient({ label: 'test', fetch }, { intervalMs: 1000 })

    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)

    client.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refresh polls immediately without doubling the schedule', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => ({}))
    const client = new MetricsClient({ label: 'test', fetch }, { intervalMs: 1000 })

    client.start()
    await vi.advanceTimersByTimeAsync(0)
    await client.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(3)

    client.stop()
  })

  describe('logs', () => {
    function logSource(pages: Array<{ entries: any[], latestId: number } | Error>) {
      const calls: number[] = []
      return {
        calls,
        source: {
          label: 'test',
          fetch: async () => ({}),
          fetchLogs: async (afterId: number) => {
            calls.push(afterId)
            const page = pages.shift()!
            if (page instanceof Error)
              throw page
            return page
          },
        },
      }
    }

    const entry = (id: number) => ({ id, timestamp: 0, level: 'info', message: `line ${id}` })

    it('appends only new lines and asks for what comes after', async () => {
      const { source, calls } = logSource([
        { entries: [entry(1), entry(2)], latestId: 2 },
        { entries: [entry(3)], latestId: 3 },
      ])
      const client = new MetricsClient(source)

      await client.poll()
      await client.poll()

      expect(calls).toEqual([0, 2])
      expect(client.state.logs.map(l => l.id)).toEqual([1, 2, 3])
      expect(client.state.logsAvailable).toBe(true)
    })

    it('starts over when the server restarts', async () => {
      const { source, calls } = logSource([
        { entries: [entry(1), entry(2), entry(3)], latestId: 3 },
        { entries: [], latestId: 1 },
        { entries: [entry(1)], latestId: 1 },
      ])
      const client = new MetricsClient(source)

      await client.poll()
      await client.poll()

      expect(calls).toEqual([0, 3, 0])
      expect(client.state.logs.map(l => l.id)).toEqual([1])
    })

    it('stops asking once the server says logs are not available', async () => {
      const { source, calls } = logSource([new MetricsSourceError('not found', 'disabled')])
      const client = new MetricsClient(source)

      await client.poll()
      await client.poll()

      expect(calls).toEqual([0])
      expect(client.state.logsAvailable).toBe(false)
      expect(client.state.status).toBe('live')
    })

    it('keeps trying after a transient log error', async () => {
      const { source, calls } = logSource([
        new MetricsSourceError('blip', 'unreachable'),
        { entries: [entry(1)], latestId: 1 },
      ])
      const client = new MetricsClient(source)

      await client.poll()
      await client.poll()

      expect(calls).toEqual([0, 0])
      expect(client.state.logs).toHaveLength(1)
    })

    it('caps the number of lines kept', async () => {
      const entries = Array.from({ length: MAX_LOG_LINES + 10 }, (_, i) => entry(i + 1))
      const { source } = logSource([{ entries, latestId: entries.length }])
      const client = new MetricsClient(source)

      await client.poll()

      expect(client.state.logs).toHaveLength(MAX_LOG_LINES)
      expect(client.state.logs[0].id).toBe(11)
    })

    it('follows requests the same way as logs', async () => {
      const request = (id: number) => ({ id, timestamp: 0, method: 'GET', path: `/${id}`, status: 200, durationMs: 1, bytes: 1, address: null })
      const pages = [{ entries: [request(1), request(2)], latestId: 2 }, { entries: [request(3)], latestId: 3 }]
      const calls: number[] = []
      const client = new MetricsClient({
        label: 'test',
        fetch: async () => ({}),
        fetchRequests: async (afterId: number) => {
          calls.push(afterId)
          return pages.shift()!
        },
      })

      expect(client.state.logsAvailable).toBe(false)
      await client.poll()
      await client.poll()

      expect(calls).toEqual([0, 2])
      expect(client.state.requests.map(r => r.path)).toEqual(['/1', '/2', '/3'])
      expect(client.state.requestsAvailable).toBe(true)
    })

    it('marks requests unavailable on an older server without failing the poll', async () => {
      const client = new MetricsClient({
        label: 'test',
        fetch: async () => ({}),
        fetchRequests: async () => {
          throw new MetricsSourceError('not found', 'disabled')
        },
      })

      await client.poll()

      expect(client.state.requestsAvailable).toBe(false)
      expect(client.state.status).toBe('live')
    })

    it('derives the requests url from the metrics url', async () => {
      const fetch = vi.fn(async () => response(200, { entries: [], latestId: 0 }))
      const source = httpSource({ url: 'http://localhost:8050/api/game/metrics', fetch })

      await source.fetchRequests!(7)

      expect(fetch).toHaveBeenCalledWith('http://localhost:8050/api/game/requests?after=7', expect.anything())
    })

    it('derives the logs url from the metrics url', async () => {
      const fetch = vi.fn(async () => response(200, { entries: [], latestId: 0 }))
      const source = httpSource({ url: 'http://localhost:8050/api/game/metrics', fetch })

      await source.fetchLogs!(5)

      expect(fetch).toHaveBeenCalledWith('http://localhost:8050/api/game/logs?after=5', expect.anything())
    })
  })
})
