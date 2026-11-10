// @vitest-environment jsdom

import type { ChatMessage } from '../src/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatBox, { nameColor } from '../src/ChatBox'
import plugin, { CHAT_EVENT, sendChat } from '../src/client'

const said = (text: string, id = 1, from: ChatMessage['from'] = { id: 'a1', name: 'Ada' }): ChatMessage => ({ id, from, text, at: 0 })

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.replaceChildren()
  document.head.replaceChildren()
})

describe('chatBox', () => {
  it('shows who said what, as text', () => {
    const box = new ChatBox({ send: () => {} })

    box.add(said('hello <b>there</b>'))
    box.add(said('<img src=x onerror=alert(1)>', 2, { id: 'b2', name: '<script>Bob</script>' }))

    const lines = [...box.log.children]
    expect(lines.map(line => line.textContent)).toEqual(['Adahello <b>there</b>', '<script>Bob</script><img src=x onerror=alert(1)>'])
    // Nothing a player sends becomes an element
    expect(box.log.querySelector('b, img, script')).toBeNull()
    expect(lines[0].querySelector('.mavonengine-chat-name')!.textContent).toBe('Ada')
  })

  it('tells players apart by colour, the same one every time', () => {
    const box = new ChatBox({ send: () => {} })
    box.add(said('one'))
    box.add(said('two', 2, { id: 'b2', name: 'Bob' }))
    box.add(said('three', 3))

    const colors = Array.from(box.log.querySelectorAll<HTMLElement>('.mavonengine-chat-name'), name => name.style.color)
    expect(colors[0]).toBe(colors[2])
    expect(colors[0]).not.toBe(colors[1])
    expect(nameColor('a1')).toBe(nameColor('a1'))
  })

  it('shows what the server says and notices apart from what players say', () => {
    const box = new ChatBox({ send: () => {} })

    box.add(said('Ada joined', 1, null))
    box.notice('You are sending messages too fast, wait 3 s')

    expect(Array.from(box.log.children, line => [line.className, line.textContent])).toEqual([
      ['mavonengine-chat-system', 'Ada joined'],
      ['mavonengine-chat-notice', 'You are sending messages too fast, wait 3 s'],
    ])
  })

  it('keeps only the newest lines', () => {
    const box = new ChatBox({ send: () => {}, maxMessages: 3 })

    for (let i = 1; i <= 5; i++)
      box.add(said(`message ${i}`, i))

    expect(Array.from(box.log.children, line => line.textContent)).toEqual(['Adamessage 3', 'Adamessage 4', 'Adamessage 5'])
  })

  it('sends what is typed on Enter and gives the keyboard back to the game', () => {
    const send = vi.fn()
    const box = new ChatBox({ send })
    box.input.focus()
    box.input.value = '  hello  '

    key(box.input, 'Enter')

    expect(send).toHaveBeenCalledWith('hello')
    expect(box.input.value).toBe('')
    expect(document.activeElement).not.toBe(box.input)
  })

  it('sends nothing for an empty line, or while an input method is composing', () => {
    const send = vi.fn()
    const box = new ChatBox({ send })
    box.input.focus()

    box.input.value = '   '
    key(box.input, 'Enter')
    expect(send).not.toHaveBeenCalled()

    box.input.focus()
    box.input.value = 'にほ'
    key(box.input, 'Enter', { isComposing: true })
    expect(send).not.toHaveBeenCalled()
    expect(box.input.value).toBe('にほ')
  })

  it('starts typing on the open key, and leaves on Escape', () => {
    const box = new ChatBox({ send: () => {} })

    const opened = key(document.body, 'Enter')
    expect(document.activeElement).toBe(box.input)
    expect(opened.defaultPrevented).toBe(true)
    expect(box.element.classList.contains('open')).toBe(true)

    key(box.input, 'Escape')
    expect(document.activeElement).not.toBe(box.input)
    expect(box.element.classList.contains('open')).toBe(false)
  })

  it('doesn\'t take the keyboard from something else that is being typed in', () => {
    const box = new ChatBox({ send: () => {} })
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()

    key(other, 'Enter')

    expect(document.activeElement).toBe(other)
    expect(box.element.classList.contains('open')).toBe(false)
  })

  it('keeps what is typed in the chat away from the game\'s key handlers', () => {
    const box = new ChatBox({ send: () => {} })
    const game = vi.fn()
    window.addEventListener('keydown', game)
    window.addEventListener('keyup', game)
    box.input.focus()

    key(box.input, 'w')
    box.input.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }))
    expect(game).not.toHaveBeenCalled()

    // The game still gets its keys otherwise
    key(document.body, 'w')
    expect(game).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', game)
    window.removeEventListener('keyup', game)
  })

  it('takes a different open key, placeholder and length', () => {
    const box = new ChatBox({ send: () => {}, openKey: 't', placeholder: 'Say something', maxLength: 80 })

    expect(box.input.placeholder).toBe('Say something')
    expect(box.input.maxLength).toBe(80)
    key(document.body, 'Enter')
    expect(document.activeElement).not.toBe(box.input)
    key(document.body, 't')
    expect(document.activeElement).toBe(box.input)
    expect(new ChatBox({ send: () => {} }).input.placeholder).toBe('Press Enter to chat')
  })

  it('can be hidden, and doesn\'t open while it is', () => {
    const box = new ChatBox({ send: () => {} })
    box.input.focus()

    box.hide()
    expect(box.element.hidden).toBe(true)
    key(document.body, 'Enter')
    expect(document.activeElement).not.toBe(box.input)

    box.show()
    key(document.body, 'Enter')
    expect(document.activeElement).toBe(box.input)
  })

  it('adds its style once, and cleans up after itself', () => {
    const first = new ChatBox({ send: () => {} })
    const second = new ChatBox({ send: () => {} })
    expect(document.querySelectorAll('#mavonengine-chat-style')).toHaveLength(1)
    expect(first.log.getAttribute('role')).toBe('log')

    first.destroy()
    second.destroy()
    expect(document.querySelector('.mavonengine-chat')).toBeNull()
    key(document.body, 'Enter')
    expect(document.activeElement).toBe(document.body)
  })
})

describe('chat client plugin', () => {
  /** A game as far as the chat sees it: events, and a connection that shows up later */
  function game(options: object = {}) {
    const handlers = new Map<string, (data: unknown) => void>()
    const socket = { on: vi.fn((event: string, callback: (data: unknown) => void) => void handlers.set(event, callback)), emit: vi.fn() }
    const instance: any = { trigger: vi.fn() }
    const ctx = { game: instance, options, package: '@mavonengine/chat', logger: null } as any

    plugin.setup!(ctx)

    return {
      ctx,
      socket,
      instance,
      connect: () => {
        instance.network = { socket }
        plugin.update!(0.016, ctx)
      },
      receive: (event: string, data: unknown) => handlers.get(event)?.(data),
      log: () => Array.from(document.querySelectorAll('.mavonengine-chat-log li'), line => line.textContent),
      input: () => document.querySelector<HTMLInputElement>('.mavonengine-chat-input')!,
    }
  }

  it('puts the chat on screen and waits for the game to connect', () => {
    const { ctx, socket, connect } = game()

    expect(document.querySelector('.mavonengine-chat')).not.toBeNull()
    plugin.update!(0.016, ctx)
    expect(socket.on).not.toHaveBeenCalled()
    expect(sendChat(ctx, 'too early')).toBe(false)

    connect()
    connect()

    // Listens once, however often it is updated
    expect(socket.on.mock.calls.map(call => call[0])).toEqual(['chat:message', 'chat:history', 'chat:notice'])
  })

  it('sends what is typed to the server, reliably', () => {
    const { socket, connect, input } = game()
    connect()

    input().focus()
    input().value = 'hello'
    key(input(), 'Enter')

    expect(socket.emit).toHaveBeenCalledWith('chat:send', { text: 'hello' }, { reliable: true })
  })

  it('shows what is said and tells the game', () => {
    const { connect, receive, instance, log } = game()
    connect()

    receive('chat:history', { messages: [said('earlier', 1)] })
    receive('chat:message', said('now', 2))
    receive('chat:notice', { text: 'You are muted' })

    expect(log()).toEqual(['Adaearlier', 'Adanow', 'You are muted'])
    // The game only hears what is said right now, e.g. for a bubble over the player
    expect(instance.trigger.mock.calls).toEqual([[CHAT_EVENT, said('now', 2)]])
    expect(CHAT_EVENT).toBe('chat:message')
  })

  it('lets the game talk and listen without the chat box', () => {
    const { ctx, socket, connect, receive, instance } = game({ ui: false })
    connect()

    expect(document.querySelector('.mavonengine-chat')).toBeNull()
    expect(sendChat(ctx, 'from the game\'s own UI')).toBe(true)
    expect(socket.emit).toHaveBeenCalledWith('chat:send', { text: 'from the game\'s own UI' }, { reliable: true })

    receive('chat:message', said('hi'))
    expect(instance.trigger).toHaveBeenCalledWith('chat:message', said('hi'))
  })

  it('takes its options from mavonengine.json', () => {
    const { input } = game({ openKey: 't', placeholder: 'Talk', maxLength: 50, maxMessages: 'lots' })

    expect(input().placeholder).toBe('Talk')
    expect(input().maxLength).toBe(50)
    key(document.body, 't')
    expect(document.activeElement).toBe(input())
  })

  it('hides while the editor is open', () => {
    const { ctx } = game()

    plugin.editor!(ctx)

    expect(document.querySelector<HTMLElement>('.mavonengine-chat')!.hidden).toBe(true)
  })

  it('follows a new connection', () => {
    const { ctx, instance, connect } = game()
    connect()
    const reconnected = { on: vi.fn(), emit: vi.fn() }
    instance.network = { socket: reconnected }

    plugin.update!(0.016, ctx)
    sendChat(ctx, 'still here')

    expect(reconnected.on).toHaveBeenCalledTimes(3)
    expect(reconnected.emit).toHaveBeenCalledWith('chat:send', { text: 'still here' }, { reliable: true })
  })
})
