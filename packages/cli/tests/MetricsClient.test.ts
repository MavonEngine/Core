import { afterEach, describe, expect, it, vi } from 'vitest'
import MetricsClient, { httpSource, MetricsSourceError } from '../src/dashboard/MetricsClient'

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
})
