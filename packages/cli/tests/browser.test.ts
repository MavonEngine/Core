import { describe, expect, it } from 'vitest'
import { canOpenBrowserHere, openCommand, servesPage } from '../src/browser'

describe('openCommand', () => {
  it('uses the opener of each platform', () => {
    expect(openCommand('http://localhost:8050/', 'darwin')).toEqual(['open', ['http://localhost:8050/']])
    expect(openCommand('http://localhost:8050/', 'linux')).toEqual(['xdg-open', ['http://localhost:8050/']])
    expect(openCommand('http://localhost:8050/?a=1&b=2', 'win32')).toEqual(['cmd', ['/c', 'start', '""', 'http://localhost:8050/?a=1^&b=2']])
  })
})

describe('canOpenBrowserHere', () => {
  it('is false over SSH', () => {
    expect(canOpenBrowserHere({})).toBe(true)
    expect(canOpenBrowserHere({ SSH_CONNECTION: '10.0.0.1 51234 10.0.0.2 22' })).toBe(false)
    expect(canOpenBrowserHere({ SSH_TTY: '/dev/ttys001' })).toBe(false)
  })
})

describe('servesPage', () => {
  const answer = (body: string, init: ResponseInit) => (async () => new Response(body, init)) as typeof fetch

  it('is true for an HTML page', async () => {
    expect(await servesPage('http://localhost:8050/', { fetch: answer('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })).toBe(true)
  })

  it('is false for errors, other content and unreachable servers', async () => {
    const refused = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch

    expect(await servesPage('http://localhost:8050/', { fetch: answer('Cannot GET /', { status: 404, headers: { 'content-type': 'text/html' } }) })).toBe(false)
    expect(await servesPage('http://localhost:8050/', { fetch: answer('{}', { headers: { 'content-type': 'application/json' } }) })).toBe(false)
    expect(await servesPage('http://localhost:8050/', { fetch: refused })).toBe(false)
  })
})
