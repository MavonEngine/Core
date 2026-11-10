import { describe, expect, it } from 'vitest'
import ChatRoom, { resolveChatOptions } from '../src/ChatRoom'

const ada = { id: 'a1', name: 'Ada' }
const bob = { id: 'b2', name: 'Bob' }

function room(options: Parameters<typeof resolveChatOptions>[0] = {}) {
  const clock = { now: 1_000_000 }
  return { clock, room: new ChatRoom(resolveChatOptions(options), () => clock.now) }
}

describe('resolveChatOptions', () => {
  it('fills in the defaults', () => {
    expect(resolveChatOptions()).toEqual({
      maxLength: 200,
      rateLimit: { messages: 5, perMs: 10_000 },
      history: 50,
      range: 0,
      announce: true,
      path: '/api/chat',
    })
  })

  it('takes what mavonengine.json says', () => {
    expect(resolveChatOptions({ maxLength: 80, rateLimit: { messages: 2, perSeconds: 30 }, history: 0, range: 25, announce: false, path: 'admin/chat/' })).toEqual({
      maxLength: 80,
      rateLimit: { messages: 2, perMs: 30_000 },
      history: 0,
      range: 25,
      announce: false,
      path: '/admin/chat',
    })
  })

  it('has no admin token of its own: the server\'s guards its admin API', () => {
    expect(resolveChatOptions({ adminToken: 'ignored' } as any)).not.toHaveProperty('adminToken')
  })

  it('falls back to the default for nonsense', () => {
    const options = resolveChatOptions({ maxLength: -5, rateLimit: { messages: 0, perSeconds: Number.NaN }, history: -1, range: 'far' as any, path: '/' })

    expect(options).toMatchObject({ maxLength: 200, rateLimit: { messages: 5, perMs: 10_000 }, history: 50, range: 0, path: '/api/chat' })
  })
})

describe('chatRoom', () => {
  it('passes on what a player says, with who said it and when', () => {
    const { room: chat, clock } = room()

    expect(chat.say(ada, 'hello there')).toEqual({ message: { id: 1, from: ada, text: 'hello there', at: clock.now } })
    expect(chat.say(bob, 'hi')).toMatchObject({ message: { id: 2, from: bob, text: 'hi' } })
  })

  it('cleans up what is said', () => {
    const { room: chat } = room()

    expect(chat.say(ada, '  spaced\tout \n over   lines\u0007 ')).toMatchObject({ message: { text: 'spaced out over lines' } })
    // Markup is text like any other: the client never treats it as HTML
    expect(chat.say(ada, '<img src=x onerror=alert(1)>')).toMatchObject({ message: { text: '<img src=x onerror=alert(1)>' } })
  })

  it('ignores what is no text or nothing', () => {
    const { room: chat } = room()

    for (const text of ['', '   ', '\n\t', undefined, null, 42, { text: 'x' }, ['x']])
      expect(chat.say(ada, text)).toEqual({ ignored: true })
    expect(chat.history).toEqual([])
  })

  it('refuses a message that is too long, counting characters as people see them', () => {
    const { room: chat } = room({ maxLength: 5 })

    expect(chat.say(ada, '12345')).toHaveProperty('message')
    expect(chat.say(ada, '123456')).toEqual({ notice: 'That message is too long, the limit is 5 characters' })
    // Five emoji are five characters
    expect(chat.say(ada, '🎮🎮🎮🎮🎮')).toHaveProperty('message')
  })

  it('limits how fast a player may talk, each player on its own', () => {
    const { room: chat, clock } = room({ rateLimit: { messages: 2, perSeconds: 10 } })

    expect(chat.say(ada, 'one')).toHaveProperty('message')
    clock.now += 4000
    expect(chat.say(ada, 'two')).toHaveProperty('message')
    expect(chat.say(ada, 'three')).toEqual({ notice: 'You are sending messages too fast, wait 6 s' })
    expect(chat.say(bob, 'unaffected')).toHaveProperty('message')

    // The first message drops out of the window
    clock.now += 6000
    expect(chat.say(ada, 'three')).toHaveProperty('message')
    expect(chat.say(ada, 'four')).toHaveProperty('notice')
  })

  it('doesn\'t count refused messages against the limit', () => {
    const { room: chat } = room({ rateLimit: { messages: 1, perSeconds: 10 }, maxLength: 3 })

    expect(chat.say(ada, 'too long')).toHaveProperty('notice')
    expect(chat.say(ada, 'ok')).toHaveProperty('message')
  })

  it('forgets what a player sent once it left', () => {
    const { room: chat } = room({ rateLimit: { messages: 1, perSeconds: 10 } })

    chat.say(ada, 'one')
    expect(chat.say(ada, 'two')).toHaveProperty('notice')
    chat.forget(ada.id)
    expect(chat.say(ada, 'two')).toHaveProperty('message')
  })

  it('keeps a muted player quiet until the mute ends or is lifted', () => {
    const { room: chat, clock } = room()

    expect(chat.mute(ada.id, 10)).toEqual({ playerId: ada.id, until: clock.now + 600_000 })
    expect(chat.say(ada, 'hello?')).toEqual({ notice: 'You are muted for another 10 min' })
    expect(chat.say(bob, 'hi')).toHaveProperty('message')
    expect(chat.listMutes()).toEqual([{ playerId: ada.id, until: clock.now + 600_000 }])

    clock.now += 9 * 60_000 + 1
    expect(chat.say(ada, 'hello?')).toEqual({ notice: 'You are muted for another 1 min' })

    clock.now += 60_000
    expect(chat.say(ada, 'back')).toHaveProperty('message')
    expect(chat.listMutes()).toEqual([])
  })

  it('mutes for good without a duration', () => {
    const { room: chat, clock } = room()

    expect(chat.mute(ada.id)).toEqual({ playerId: ada.id, until: null })
    clock.now += 365 * 24 * 3600_000
    expect(chat.say(ada, 'still here')).toEqual({ notice: 'You are muted' })
    expect(chat.mutedUntil(ada.id)).toBeNull()

    expect(chat.unmute(ada.id)).toBe(true)
    expect(chat.unmute(ada.id)).toBe(false)
    expect(chat.say(ada, 'finally')).toHaveProperty('message')
  })

  it('says things as the server', () => {
    const { room: chat, clock } = room()

    expect(chat.system('Ada joined')).toEqual({ id: 1, from: null, text: 'Ada joined', at: clock.now })
  })

  it('keeps the recent messages, oldest first', () => {
    const { room: chat } = room({ history: 3, rateLimit: { messages: 100 } })

    chat.system('Ada joined')
    for (const text of ['one', 'two', 'three'])
      chat.say(ada, text)

    expect(chat.history.map(message => message.text)).toEqual(['one', 'two', 'three'])
    // A copy: changing it changes nothing
    chat.history.pop()
    expect(chat.history).toHaveLength(3)
  })

  it('keeps nothing when history is off', () => {
    const { room: chat } = room({ history: 0 })

    chat.say(ada, 'gone')
    expect(chat.history).toEqual([])
  })
})
