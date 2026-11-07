import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BasicAuth, { parseBasicAuth } from '../src/auth/BasicAuth'

// htpasswd -nbm bob hunter2
const BOB = 'bob:$apr1$/JmjNbl4$7OwIOno5XIdi.TZFKCN801'
// htpasswd -nbs carol pa55
const CAROL = 'carol:{SHA}3jlYfsnWMi7F2C1+fdQaJ5Rr39M='

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-monitoring-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

/** Run the middleware on a fake request and report what happened */
async function call(auth: BasicAuth, { authorization, address = '203.0.113.5' }: { authorization?: string, address?: string } = {}) {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    status(code: number) {
      this.statusCode = code
      return this
    },
    type() {
      return this
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    send(body: string) {
      this.body = body
    },
  }
  const next = vi.fn()
  auth.middleware({ headers: { authorization }, socket: { remoteAddress: address } } as any, res as any, next)
  await vi.waitFor(() => expect(next.mock.calls.length > 0 || res.body !== '').toBe(true))
  return { passed: next.mock.calls.length > 0, status: res.statusCode, headers: res.headers }
}

function htpasswdFile(content: string) {
  const path = join(dir, '.htpasswd')
  writeFileSync(path, content)
  return path
}

describe('parseBasicAuth', () => {
  it('decodes user and password, which may contain colons', () => {
    expect(parseBasicAuth(basic('bob', 'a:b'))).toEqual({ user: 'bob', password: 'a:b' })
    expect(parseBasicAuth(`basic ${Buffer.from('ünï:cødé').toString('base64')}`)).toEqual({ user: 'ünï', password: 'cødé' })
  })

  it('rejects other schemes and malformed values', () => {
    expect(parseBasicAuth(undefined)).toBeUndefined()
    expect(parseBasicAuth('Bearer abc')).toBeUndefined()
    expect(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeUndefined()
    expect(parseBasicAuth('Basic !!!')).toBeUndefined()
  })
})

describe('basicAuth', () => {
  it('asks for a login with the realm', async () => {
    const auth = new BasicAuth({ realm: 'Game "ops"', credentials: { kind: 'user', user: 'ops', password: 'pw' } })

    const result = await call(auth)

    expect(result).toMatchObject({ passed: false, status: 401 })
    expect(result.headers['WWW-Authenticate']).toBe('Basic realm="Game ops", charset="UTF-8"')
  })

  it('lets in the configured user only', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const auth = new BasicAuth({ realm: 'r', credentials: { kind: 'user', user: 'ops', password: 'pw' }, logger })

    expect((await call(auth, { authorization: basic('ops', 'pw') })).passed).toBe(true)
    expect((await call(auth, { authorization: basic('ops', 'nope') })).status).toBe(401)
    expect((await call(auth, { authorization: basic('root', 'pw') })).status).toBe(401)
    expect(logger.warn).toHaveBeenCalledWith('Monitoring: failed login for "ops" from 203.0.113.5')
  })

  it('checks users from an htpasswd file', async () => {
    const auth = new BasicAuth({ realm: 'r', credentials: { kind: 'htpasswd', path: htpasswdFile(`${BOB}\n${CAROL}\n`) } })

    expect(auth.userCount).toBe(2)
    expect((await call(auth, { authorization: basic('bob', 'hunter2') })).passed).toBe(true)
    expect((await call(auth, { authorization: basic('carol', 'pa55') })).passed).toBe(true)
    expect((await call(auth, { authorization: basic('carol', 'hunter2') })).passed).toBe(false)
  })

  it('fails at startup when the htpasswd file is missing', () => {
    expect(() => new BasicAuth({ realm: 'r', credentials: { kind: 'htpasswd', path: join(dir, 'missing') } })).toThrow('ENOENT')
  })

  it('remembers a checked login so slow hashes don\'t run on every poll', async () => {
    let now = 0
    const auth = new BasicAuth({ realm: 'r', credentials: { kind: 'user', user: 'ops', password: 'pw' }, cacheMs: 1000, now: () => now })
    const verifyPassword = vi.fn(async (password: string) => password === 'pw')
    ;(auth as any).users.set('ops', verifyPassword)

    expect(await auth.verify('ops', 'pw')).toBe(true)
    now = 999
    expect(await auth.verify('ops', 'pw')).toBe(true)
    expect(verifyPassword).toHaveBeenCalledTimes(1)

    // Expired, so checked again
    now = 1000
    expect(await auth.verify('ops', 'pw')).toBe(true)
    expect(verifyPassword).toHaveBeenCalledTimes(2)

    // A wrong password is never answered from the cache
    expect(await auth.verify('ops', 'wrong')).toBe(false)
    expect(verifyPassword).toHaveBeenCalledTimes(3)
  })

  it('locks an address out after too many failures, then lets it try again', async () => {
    let now = 0
    const auth = new BasicAuth({ realm: 'r', credentials: { kind: 'user', user: 'ops', password: 'pw' }, maxFailures: 3, lockoutMs: 60000, now: () => now })

    for (let i = 0; i < 3; i++)
      await call(auth, { authorization: basic('ops', `guess${i}`) })

    const locked = await call(auth, { authorization: basic('ops', 'pw') })
    expect(locked.status).toBe(429)
    expect(locked.headers['Retry-After']).toBe('60')

    // Other addresses are not affected
    expect((await call(auth, { authorization: basic('ops', 'pw'), address: '198.51.100.7' })).passed).toBe(true)

    now = 60000
    expect((await call(auth, { authorization: basic('ops', 'pw') })).passed).toBe(true)
  })

  it('picks up htpasswd changes and logs out removed users', async () => {
    let now = 0
    const path = htpasswdFile(`${BOB}\n${CAROL}\n`)
    const auth = new BasicAuth({ realm: 'r', credentials: { kind: 'htpasswd', path }, now: () => now })
    expect(await auth.verify('bob', 'hunter2')).toBe(true)

    writeFileSync(path, CAROL)
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    now = 5000

    expect(await auth.verify('bob', 'hunter2')).toBe(false)
    expect(await auth.verify('carol', 'pa55')).toBe(true)
  })

  it('keeps the old users when the htpasswd file disappears', async () => {
    let now = 0
    const logger = { info: vi.fn(), warn: vi.fn() }
    const path = htpasswdFile(BOB)
    const auth = new BasicAuth({ realm: 'r', credentials: { kind: 'htpasswd', path }, logger, now: () => now })

    rmSync(path)
    now = 5000

    expect(await auth.verify('bob', 'hunter2')).toBe(true)
    expect(logger.warn.mock.calls[0][0]).toContain('could not re-read the htpasswd file')
  })

  describe('without a login configured', () => {
    it('only lets this machine in', async () => {
      const auth = new BasicAuth({ realm: 'r' })

      expect(auth.requiresLogin).toBe(false)
      expect((await call(auth, { address: '127.0.0.1' })).passed).toBe(true)
      expect((await call(auth, { address: '::1' })).passed).toBe(true)
      expect((await call(auth, { address: '203.0.113.5' })).status).toBe(403)
    })
  })
})
