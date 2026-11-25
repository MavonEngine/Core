// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin, { AUTH_EVENT, AuthRequestError, changeEmail, checkSession, currentAccount, login, logout, playAsGuest, register, requestPasswordReset, resendVerification, resetPassword, STORAGE_KEY, verifyEmail } from '../src/client'

const ada = { id: 'acc-1', name: 'Ada' }
const session = { token: 'tok-1', account: ada, expiresAt: '2026-12-15T00:00:00.000Z' }

let fetchMock: ReturnType<typeof vi.fn>

function answer(status: number, body?: unknown) {
  fetchMock.mockResolvedValueOnce(body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status }))
}

beforeEach(() => {
  localStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  plugin.setup({ options: {} } as any)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth client', () => {
  it('sends nothing before logging in, and the session after', async () => {
    expect(plugin.authorization()).toBeUndefined()
    answer(200, session)

    expect(await login('Ada', 'correct horse')).toEqual(ada)

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'Ada', password: 'correct horse' }),
    }))
    expect(plugin.authorization()).toBe('Bearer tok-1')
    expect(currentAccount()).toEqual(ada)
  })

  it('plays as a guest, and registers that guest with its session so it keeps its account', async () => {
    const guest = { id: 'acc-9', name: 'Guest-4821', guest: true }
    answer(201, { token: 'guest-tok', account: guest, expiresAt: '2026-12-15T00:00:00.000Z' })
    answer(201, {
      token: 'tok-2',
      account: { id: 'acc-9', name: 'Ada' },
      expiresAt: '2026-12-15T00:00:00.000Z',
    })

    expect(await playAsGuest()).toEqual(guest)
    expect(currentAccount()?.guest).toBe(true)
    expect(plugin.authorization()).toBe('Bearer guest-tok')

    await register('Ada', 'correct horse')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer guest-tok')
    expect(currentAccount()).toEqual({ id: 'acc-9', name: 'Ada' })
  })

  it('registers with an email when given one', async () => {
    answer(201, {
      ...session,
      account: { ...ada, email: 'ada@example.com' },
    })

    expect((await register('Ada', 'correct horse', 'ada@example.com')).email).toBe('ada@example.com')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ username: 'Ada', password: 'correct horse', email: 'ada@example.com' })
    expect(currentAccount()?.email).toBe('ada@example.com')
  })

  it('tells the page when the player logs in and out', async () => {
    const seen: unknown[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(AUTH_EVENT, listener)
    answer(201, session)
    answer(204)

    await register('Ada', 'correct horse')
    await logout()

    expect(seen).toEqual([ada, null])
    window.removeEventListener(AUTH_EVENT, listener)
  })

  it('forgets the session on logout, also when the server can\'t be reached', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await logout()

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-1')
    expect(plugin.authorization()).toBeUndefined()
  })

  it('rejects with what the server said', async () => {
    answer(401, { error: 'Wrong username or password' })

    const failed = await login('Ada', 'nope').catch(err => err)
    expect(failed).toBeInstanceOf(AuthRequestError)
    expect(failed).toMatchObject({ status: 401, message: 'Wrong username or password' })
    expect(plugin.authorization()).toBeUndefined()
  })

  it('drops a session the server no longer knows, keeps it when the server is only unreachable', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    answer(503, { error: 'down' })
    expect(await checkSession()).toBeUndefined()
    expect(plugin.authorization()).toBe('Bearer tok-1')

    answer(200, { account: ada })
    expect(await checkSession()).toEqual(ada)

    answer(401, { error: 'Not logged in' })
    expect(await checkSession()).toBeUndefined()
    expect(plugin.authorization()).toBeUndefined()
  })

  it('uses the path from the options, and survives storage it can\'t read', async () => {
    plugin.setup({
      options: { path: '/accounts/' },
    } as any)
    answer(200, session)
    await login('Ada', 'correct horse')
    expect(fetchMock.mock.calls[0][0]).toBe('/accounts/login')

    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(plugin.authorization()).toBeUndefined()
  })
})

describe('auth client email', () => {
  it('changes the email and keeps the account the server answers with', async () => {
    answer(200, session)
    await login('Ada', 'correct horse')
    answer(200, {
      account: { ...ada, email: 'ada@new.example.com', emailVerified: false },
    })

    expect((await changeEmail('ada@new.example.com')).email).toBe('ada@new.example.com')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/email')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-1')
    expect(currentAccount()).toEqual({ ...ada, email: 'ada@new.example.com', emailVerified: false })
    // Still logged in with the same session
    expect(plugin.authorization()).toBe('Bearer tok-1')
  })

  it('asks for a new confirmation link, and confirms with a token without being logged in', async () => {
    answer(200, session)
    await login('Ada', 'correct horse')
    answer(202, { sent: true })
    await resendVerification()
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/verify-email/send')

    answer(200, {
      account: { ...ada, email: 'ada@example.com', emailVerified: true },
    })
    expect((await verifyEmail('link-token')).emailVerified).toBe(true)
    const [url, init] = fetchMock.mock.calls[2]
    expect(url).toBe('/api/auth/verify-email')
    expect(JSON.parse(init.body)).toEqual({ token: 'link-token' })
    // The token is the proof, not the session
    expect(init.headers.Authorization).toBeUndefined()
    expect(currentAccount()?.emailVerified).toBe(true)
  })

  it('asks for a reset link, and resetting logs this browser in', async () => {
    answer(202, { sent: true })
    await requestPasswordReset('ada@example.com')
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/auth/forgot-password',
      expect.objectContaining({
        body: JSON.stringify({ email: 'ada@example.com' }),
      }),
    ])

    answer(200, { ...session, token: 'tok-new' })
    expect(await resetPassword('link-token', 'brand new horse')).toEqual(ada)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: 'link-token', password: 'brand new horse' })
    expect(plugin.authorization()).toBe('Bearer tok-new')

    answer(400, { error: 'This link doesn\'t work any more' })
    await expect(resetPassword('old', 'brand new horse')).rejects.toEqual(new AuthRequestError(400, 'This link doesn\'t work any more'))
  })
})
