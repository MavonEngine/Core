import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { announce, chatRoom, JOIN_NAME_WAIT_MS } from '../src/server'

class Position {
  constructor(public x = 0) {}
  distanceTo(other: Position) {
    return Math.abs(this.x - other.x)
  }
}

interface FakeChannel {
  id: string
  emit: ReturnType<typeof vi.fn>
  on(event: string, callback: (data: unknown) => void): void
  /** What the client sends */
  receive(event: string, data: unknown): void
  /** What it was sent, without the delivery options */
  got(event?: string): unknown[]
}

/** A game server as far as the chat sees it: connections, the entities of the players, a logger */
function world(options: object = {}) {
  const connections = new Map<string, { channel: FakeChannel }>()
  const entities = new Map<string, any>()
  const server = { gameSocket: { connectionsManager: { connections } } }
  const ctx = { server, game: { world: { entities: { items: entities } } }, logger: { info: vi.fn() }, options, package: '@mavonengine/chat' } as any

  plugin.setup!(ctx)

  function connect(id: string, { name, x = 0, player = true }: { name?: string, x?: number, player?: boolean } = {}) {
    const handlers = new Map<string, (data: unknown) => void>()
    const emit = vi.fn()
    const channel: FakeChannel = {
      id,
      emit,
      on: (event, callback) => void handlers.set(event, callback),
      receive: (event, data) => handlers.get(event)?.(data),
      got: event => emit.mock.calls.filter(call => !event || call[0] === event).map(call => call[1]),
    }
    connections.set(id, { channel })
    if (player)
      entities.set(id, { id, name, position: new Position(x) })
    plugin.onConnection!(channel as any, entities.get(id), ctx)
    return channel
  }

  function disconnect(channel: FakeChannel) {
    connections.delete(channel.id)
    plugin.onDisconnect!(channel as any, ctx)
    entities.delete(channel.id)
  }

  return { ctx, connect, disconnect, entities, tick: () => plugin.tick!(0.033, ctx) }
}

const texts = (messages: unknown[]) => (messages as { text: string }[]).map(message => message.text)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('chat server plugin', () => {
  it('passes what a player says on to everyone, reliably', () => {
    const { connect } = world({ announce: false })
    const ada = connect('a1', { name: 'Ada' })
    const bob = connect('b2', { name: 'Bob' })

    ada.receive('chat:send', { text: ' hello  there ' })

    for (const channel of [ada, bob])
      expect(channel.got('chat:message')).toEqual([{ id: 1, from: { id: 'a1', name: 'Ada' }, text: 'hello there', at: expect.any(Number) }])
    expect(bob.emit).toHaveBeenCalledWith('chat:message', expect.anything(), { reliable: true })
  })

  it('names a player by its display name, its name, or its id', () => {
    const { connect, entities } = world({ announce: false })
    const ada = connect('a1')

    ada.receive('chat:send', { text: 'one' })
    entities.get('a1').name = 'Ada'
    ada.receive('chat:send', { text: 'two' })
    entities.get('a1').displayName = 'Countess Ada'
    ada.receive('chat:send', { text: 'three' })
    // A display name that is just the id, like the engine's default, is no name
    entities.get('a1').displayName = 'a1'
    ada.receive('chat:send', { text: 'four' })

    expect((ada.got('chat:message') as any[]).map(message => message.from.name)).toEqual(['a1', 'Ada', 'Countess Ada', 'Ada'])
  })

  it('tells only the sender when its message is not passed on', () => {
    const { connect } = world({ announce: false, maxLength: 5 })
    const ada = connect('a1', { name: 'Ada' })
    const bob = connect('b2', { name: 'Bob' })

    ada.receive('chat:send', { text: 'far too long' })
    ada.receive('chat:send', { text: '   ' })
    ada.receive('chat:send', null)

    expect(ada.got('chat:notice')).toEqual([{ text: 'That message is too long, the limit is 5 characters' }])
    expect(bob.emit).not.toHaveBeenCalledWith('chat:notice', expect.anything(), expect.anything())
    expect(bob.got('chat:message')).toEqual([])
  })

  it('doesn\'t let a connection without a player talk', () => {
    const { connect } = world({ announce: false })
    const ada = connect('a1', { name: 'Ada' })
    const editor = connect('e9', { player: false })

    editor.receive('chat:send', { text: 'I am not here' })
    ada.receive('chat:send', { text: 'hello' })

    expect(texts(ada.got('chat:message'))).toEqual(['hello'])
    // It still hears everything
    expect(texts(editor.got('chat:message'))).toEqual(['hello'])
  })

  it('sends a new client what was said before', () => {
    const { connect } = world({ announce: false })
    const ada = connect('a1', { name: 'Ada' })
    ada.receive('chat:send', { text: 'anyone?' })

    const bob = connect('b2', { name: 'Bob' })

    expect(ada.got('chat:history')).toEqual([{ messages: [] }])
    expect(bob.got('chat:history')).toEqual([{ messages: [expect.objectContaining({ text: 'anyone?', from: { id: 'a1', name: 'Ada' } })] }])
  })

  describe('proximity', () => {
    it('is only heard by players in range, and by the sender', () => {
      const { connect } = world({ announce: false, range: 10 })
      const ada = connect('a1', { name: 'Ada', x: 0 })
      const near = connect('n2', { name: 'Near', x: 10 })
      const far = connect('f3', { name: 'Far', x: 10.5 })
      const editor = connect('e9', { player: false })

      ada.receive('chat:send', { text: 'psst' })

      expect(texts(ada.got('chat:message'))).toEqual(['psst'])
      expect(texts(near.got('chat:message'))).toEqual(['psst'])
      expect(far.got('chat:message')).toEqual([])
      expect(texts(editor.got('chat:message'))).toEqual(['psst'])
    })

    it('sends no history, which could have been said out of earshot', () => {
      const { connect } = world({ announce: false, range: 10 })

      expect(connect('a1', { name: 'Ada' }).got('chat:history')).toEqual([])
    })

    it('reaches everyone with what the server says', () => {
      const { ctx, connect } = world({ announce: false, range: 10 })
      const ada = connect('a1', { name: 'Ada', x: 0 })
      const far = connect('f3', { name: 'Far', x: 500 })

      announce(ctx, 'Server restarts in 5 minutes')

      expect(texts(far.got('chat:message'))).toEqual(['Server restarts in 5 minutes'])
      expect(texts(ada.got('chat:message'))).toEqual(['Server restarts in 5 minutes'])
    })
  })

  describe('join and leave', () => {
    it('says who joined once the game has named the player', () => {
      const { connect, entities, tick } = world()
      const ada = connect('a1')

      tick()
      expect(ada.got('chat:message')).toEqual([])

      entities.get('a1').name = 'Ada'
      tick()
      tick()

      expect(ada.got('chat:message')).toEqual([{ id: 1, from: null, text: 'Ada joined', at: expect.any(Number) }])
    })

    it('uses the id when no name comes', () => {
      vi.useFakeTimers()
      const { connect, tick } = world()
      const ada = connect('a1')

      vi.advanceTimersByTime(JOIN_NAME_WAIT_MS - 1)
      tick()
      expect(ada.got('chat:message')).toEqual([])

      vi.advanceTimersByTime(1)
      tick()
      expect(texts(ada.got('chat:message'))).toEqual(['a1 joined'])
    })

    it('says who left, by the name it last had', () => {
      const { connect, disconnect, entities, tick } = world({ rateLimit: { messages: 100 } })
      const ada = connect('a1', { name: 'Ada' })
      const bob = connect('b2', { name: 'Bob' })
      tick()

      entities.get('b2').name = 'Robert'
      bob.receive('chat:send', { text: 'new name' })
      disconnect(bob)

      expect(texts(ada.got('chat:message'))).toEqual(['Ada joined', 'Bob joined', 'new name', 'Robert left'])
      expect(bob.got('chat:message')).toHaveLength(3)
    })

    it('says nothing about someone who left before it was said to have joined', () => {
      const { connect, disconnect, tick } = world()
      const ada = connect('a1', { name: 'Ada' })
      tick()
      const ghost = connect('g7')

      disconnect(ghost)
      tick()

      expect(texts(ada.got('chat:message'))).toEqual(['Ada joined'])
    })

    it('says nothing when announcing is off, or for a connection without a player', () => {
      const quiet = world({ announce: false })
      const ada = quiet.connect('a1', { name: 'Ada' })
      quiet.tick()
      quiet.disconnect(quiet.connect('b2', { name: 'Bob' }))
      expect(ada.got('chat:message')).toEqual([])

      const loud = world()
      const eve = loud.connect('e1', { name: 'Eve' })
      loud.tick()
      loud.disconnect(loud.connect('e9', { player: false }))
      loud.tick()
      expect(texts(eve.got('chat:message'))).toEqual(['Eve joined'])
    })
  })

  it('forgets a player\'s recent messages when it leaves, and stops when the server does', () => {
    const { ctx, connect, disconnect } = world({ announce: false, rateLimit: { messages: 1, perSeconds: 60 } })
    const ada = connect('a1', { name: 'Ada' })
    ada.receive('chat:send', { text: 'one' })
    ada.receive('chat:send', { text: 'two' })
    expect(ada.got('chat:notice')).toHaveLength(1)

    disconnect(ada)
    const again = connect('a1', { name: 'Ada' })
    again.receive('chat:send', { text: 'two' })
    expect(texts(again.got('chat:message'))).toEqual(['two'])

    plugin.destroy!(ctx)
    expect(chatRoom(ctx)).toBeUndefined()
    expect(announce(ctx, 'anyone?')).toBeUndefined()
  })

  describe('admin api', () => {
    let close: (() => void) | undefined

    afterEach(() => {
      close?.()
      close = undefined
    })

    async function api(options: object = {}, context: object = {}) {
      const game = world({ announce: false, ...options })
      Object.assign(game.ctx, context)
      const app = express()
      plugin.http!(app, game.ctx)

      const listener = await new Promise<import('node:http').Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
      })
      close = () => listener.close()
      const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
      const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init)
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers })

      return { ...game, app, request, post }
    }

    it('reads the chat and announces things in it', async () => {
      const { connect, request, post } = await api()
      const ada = connect('a1', { name: 'Ada' })
      ada.receive('chat:send', { text: 'hello' })

      const announced = await post('/api/chat/messages', { text: '  Server restarts\nsoon ' })
      expect(await announced.json()).toEqual({ message: { id: 2, from: null, text: 'Server restarts soon', at: expect.any(Number) } })
      expect(texts(ada.got('chat:message'))).toEqual(['hello', 'Server restarts soon'])

      const { messages } = await (await request('/api/chat/messages')).json() as { messages: { text: string }[] }
      expect(texts(messages)).toEqual(['hello', 'Server restarts soon'])

      expect((await post('/api/chat/messages', {})).status).toBe(400)
      expect((await post('/api/chat/messages', 'not json')).status).toBe(400)
    })

    it('mutes and unmutes players', async () => {
      const { ctx, connect, request, post } = await api()
      const ada = connect('a1', { name: 'Ada' })

      const muted = await post('/api/chat/mutes', { playerId: 'a1', minutes: 5 })
      expect(await muted.json()).toEqual({ mute: { playerId: 'a1', until: expect.any(Number) } })
      expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('Chat: muted a1 until '))

      ada.receive('chat:send', { text: 'hello?' })
      expect(ada.got('chat:notice')).toEqual([{ text: 'You are muted for another 5 min' }])
      expect(await (await request('/api/chat/mutes')).json()).toEqual({ mutes: [{ playerId: 'a1', until: expect.any(Number) }] })

      expect(await (await request('/api/chat/mutes/a1', { method: 'DELETE' })).json()).toEqual({ unmuted: true })
      expect(await (await request('/api/chat/mutes/a1', { method: 'DELETE' })).json()).toEqual({ unmuted: false })
      ada.receive('chat:send', { text: 'back' })
      expect(texts(ada.got('chat:message'))).toEqual(['back'])

      expect(await (await post('/api/chat/mutes', { playerId: 'a1' })).json()).toEqual({ mute: { playerId: 'a1', until: null } })
      expect((await post('/api/chat/mutes', { minutes: 5 })).status).toBe(400)
    })

    it('is guarded by the server\'s admin guard, which the plugin gets from the engine', async () => {
      // What core hands every plugin: asks for the server's admin token
      const requireAdmin = vi.fn((req: any, res: any, next: () => void) => {
        if (req.headers.authorization === 'Bearer server-admin-token')
          next()
        else
          res.status(401).json({ error: 'Invalid admin token' })
      })
      const { request, post } = await api({}, { requireAdmin })

      expect((await request('/api/chat/messages')).status).toBe(401)
      expect((await post('/api/chat/messages', { text: 'hi' })).status).toBe(401)
      expect((await request('/api/chat/mutes')).status).toBe(401)
      expect((await post('/api/chat/mutes', { playerId: 'a1' })).status).toBe(401)
      expect((await request('/api/chat/mutes/a1', { method: 'DELETE' })).status).toBe(401)
      expect(requireAdmin).toHaveBeenCalledTimes(5)

      const headers = { Authorization: 'Bearer server-admin-token' }
      expect((await request('/api/chat/messages', { headers })).status).toBe(200)
      expect((await post('/api/chat/mutes', { playerId: 'a1' }, headers)).status).toBe(200)
    })

    it('has no token of its own', async () => {
      vi.stubEnv('MAVONENGINE_CHAT_ADMIN_TOKEN', 'old-way')
      const { request } = await api({ adminToken: 'old-way' })

      // Neither the option nor the variable of earlier versions does anything: localhost gets in as before
      expect((await request('/api/chat/mutes')).status).toBe(200)
    })

    it('only answers localhost on a core without an admin guard', async () => {
      const { app } = await api()
      // What Express would hand the route for a request from another machine
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
      const next = vi.fn()
      const layer = (app as any).router.stack.find((entry: any) => entry.route?.path === '/api/chat/mutes' && entry.route.methods.get)
      const guard = layer.route.stack[1].handle

      guard({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }, res, next)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()

      guard({ headers: {}, socket: { remoteAddress: '::1' } }, res, next)
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('is served under the configured path and says what its routes do', async () => {
      const { app, request } = await api({ path: '/admin/talk' })

      expect((await request('/admin/talk/messages')).status).toBe(200)
      expect((await request('/api/chat/messages')).status).toBe(404)

      // What the engine's endpoint list reads
      const docs = (app as any).router.stack.filter((entry: any) => entry.route).map((entry: any) => [Object.keys(entry.route.methods)[0], entry.route.path, entry.route.stack[0].handle[Symbol.for('mavonengine.routeDoc')]?.summary])
      expect(docs).toEqual([
        ['get', '/admin/talk/messages', 'The recent chat messages'],
        ['post', '/admin/talk/messages', 'Announce something in the chat'],
        ['get', '/admin/talk/mutes', 'The players that are muted'],
        ['post', '/admin/talk/mutes', 'Mute a player'],
        ['delete', '/admin/talk/mutes/:playerId', 'Unmute a player'],
      ])
    })
  })
})
