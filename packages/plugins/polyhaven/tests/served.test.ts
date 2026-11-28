import { describe, expect, it, vi } from 'vitest'
import { waitUntilServed } from '../src/served'

function html() {
  return new Response('<html>', {
    headers: { 'content-type': 'text/html' },
  })
}
function jpeg() {
  return new Response(null, {
    headers: { 'content-type': 'image/jpeg' },
  })
}

describe('waitUntilServed', () => {
  it('waits while the dev server answers with its page instead of the new files', async () => {
    let ready = false
    const fetchMock = vi.fn(async (url: string) => ready || url.endsWith('old.jpg')
      ? jpeg()
      : html())
    setTimeout(() => {
      ready = true
    }, 200)
    await waitUntilServed(['/p/old.jpg', '/p/new.jpg'], fetchMock as unknown as typeof fetch)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/p/new.jpg').length).toBeGreaterThan(1)
    // A file served once isn't asked for again
    expect(fetchMock.mock.calls.filter(([url]) => url === '/p/old.jpg').length).toBe(1)
  })

  it('gives up with the files it never got', async () => {
    vi.useFakeTimers()
    try {
      const done = waitUntilServed(['/p/never.jpg'], (async () => html()) as unknown as typeof fetch)
      const check = expect(done).rejects.toThrow(/\/p\/never.jpg/)
      await vi.advanceTimersByTimeAsync(20_000)
      await check
    }
    finally {
      vi.useRealTimers()
    }
  })
})
