import type { ChatMessage } from './protocol.js'

export interface ChatBoxOptions {
  /** Called with what the player typed when it presses Enter */
  send(text: string): void
  /** How many lines the log keeps. Default 100 */
  maxMessages?: number
  /** Longest text the input takes. Default 200, the server's default limit */
  maxLength?: number
  /** Key that puts the cursor in the chat while the game has the keyboard. Default `Enter` */
  openKey?: string
  /** Shown in the empty input */
  placeholder?: string
  /** Corner of the page the chat sits in. Default `bottom-left` */
  position?: ChatPosition
  document?: Document
}

export type ChatPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

const POSITIONS: ChatPosition[] = ['bottom-left', 'bottom-right', 'top-left', 'top-right']

const STYLE_ID = 'mavonengine-chat-style'

/**
 * Colours come from custom properties, so a game restyles the chat by setting them on `.mavonengine-chat`
 * or any parent. The log lets clicks through to the game until the chat is being typed in.
 */
const STYLE = `
.mavonengine-chat {
  --chat-bg: rgb(12 14 18 / 72%);
  --chat-bg-idle: rgb(12 14 18 / 38%);
  --chat-text: #f2f4f7;
  --chat-muted: #aab2bf;
  --chat-accent: #6cb6ff;
  --chat-border: rgb(255 255 255 / 16%);
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(360px, calc(100vw - 24px));
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--chat-text);
  pointer-events: none;
}
.mavonengine-chat.bottom-right, .mavonengine-chat.top-right { left: auto; right: 12px; }
.mavonengine-chat.top-left, .mavonengine-chat.top-right { bottom: auto; top: 12px; flex-direction: column-reverse; }
.mavonengine-chat[hidden] { display: none; }
.mavonengine-chat-log {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(220px, 40vh);
  margin: 0;
  padding: 8px 10px;
  list-style: none;
  border-radius: 6px;
  background: var(--chat-bg-idle);
  overflow-y: auto;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
  text-shadow: 0 1px 2px rgb(0 0 0 / 70%);
}
.mavonengine-chat-log:empty { display: none; }
.mavonengine-chat.open .mavonengine-chat-log { background: var(--chat-bg); pointer-events: auto; }
.mavonengine-chat-name { font-weight: 600; }
.mavonengine-chat-name::after { content: ': '; }
.mavonengine-chat-system { color: var(--chat-muted); font-style: italic; }
.mavonengine-chat-notice { color: #ffd479; }
.mavonengine-chat-input {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--chat-border);
  border-radius: 6px;
  background: var(--chat-bg-idle);
  color: var(--chat-text);
  font: inherit;
  pointer-events: auto;
}
.mavonengine-chat-input::placeholder { color: var(--chat-muted); }
.mavonengine-chat-input:focus { outline: 1px solid var(--chat-accent); background: var(--chat-bg); }
`

/** A colour per player, the same every time, so names are told apart at a glance */
export function nameColor(id: string): string {
  let hash = 0
  for (const char of id)
    hash = (hash * 31 + char.codePointAt(0)!) % 360
  return `hsl(${hash} 80% 72%)`
}

/**
 * The chat on screen: a log of what was said and a line to type in, in the bottom left corner.
 * Plain DOM, so it works whatever the game's UI is built with.
 *
 * Everything a player or the server says is put on the page as text, never as HTML.
 */
export default class ChatBox {
  readonly element: HTMLElement
  readonly log: HTMLElement
  readonly input: HTMLInputElement

  private document: Document
  private maxMessages: number
  private openKey: string
  private send: (text: string) => void

  constructor({ send, maxMessages = 100, maxLength = 200, openKey = 'Enter', placeholder, position = 'bottom-left', document: doc = document }: ChatBoxOptions) {
    this.document = doc
    this.send = send
    this.maxMessages = maxMessages
    this.openKey = openKey

    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE
      doc.head.appendChild(style)
    }

    this.element = doc.createElement('div')
    this.element.className = `mavonengine-chat ${POSITIONS.includes(position) ? position : 'bottom-left'}`

    this.log = doc.createElement('ul')
    this.log.className = 'mavonengine-chat-log'
    this.log.setAttribute('role', 'log')
    this.log.setAttribute('aria-live', 'polite')
    this.log.setAttribute('aria-label', 'Chat messages')

    this.input = doc.createElement('input')
    this.input.className = 'mavonengine-chat-input'
    this.input.type = 'text'
    this.input.maxLength = maxLength
    this.input.autocomplete = 'off'
    this.input.placeholder = placeholder ?? `Press ${openKey} to chat`
    this.input.setAttribute('aria-label', 'Chat message')

    this.input.addEventListener('keydown', this.onInputKey)
    // What is typed here is for the chat alone: the game's own key handlers on the window never see it
    this.input.addEventListener('keyup', event => event.stopPropagation())
    this.input.addEventListener('keypress', event => event.stopPropagation())
    this.input.addEventListener('focus', () => this.element.classList.add('open'))
    this.input.addEventListener('blur', () => this.element.classList.remove('open'))
    doc.addEventListener('keydown', this.onDocumentKey)

    this.element.append(this.log, this.input)
    doc.body.appendChild(this.element)
  }

  private onInputKey = (event: KeyboardEvent) => {
    event.stopPropagation()

    if (event.key === 'Escape') {
      this.input.blur()
      return
    }

    // Not while an input method is still composing the text
    if (event.key !== 'Enter' || event.isComposing)
      return

    const text = this.input.value.trim()
    this.input.value = ''
    if (text)
      this.send(text)
    this.input.blur()
  }

  /** The open key starts typing, unless something else on the page is being typed in */
  private onDocumentKey = (event: KeyboardEvent) => {
    if (event.key !== this.openKey || event.repeat || this.element.hidden)
      return

    const active = this.document.activeElement as HTMLElement | null
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable))
      return

    event.preventDefault()
    this.input.focus()
  }

  /** Add what someone said, or what the server said when `from` is null */
  add(message: ChatMessage): void {
    const line = this.document.createElement('li')

    if (message.from) {
      const name = this.document.createElement('span')
      name.className = 'mavonengine-chat-name'
      name.style.color = nameColor(message.from.id)
      name.textContent = message.from.name
      line.append(name, this.document.createTextNode(message.text))
    }
    else {
      line.className = 'mavonengine-chat-system'
      line.textContent = message.text
    }

    this.append(line)
  }

  /** Add a line meant for this player alone, like "you are sending messages too fast" */
  notice(text: string): void {
    const line = this.document.createElement('li')
    line.className = 'mavonengine-chat-notice'
    line.textContent = text
    this.append(line)
  }

  private append(line: HTMLElement) {
    // Someone reading back through the log is left where they are
    const atEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24

    this.log.appendChild(line)
    while (this.log.childElementCount > this.maxMessages)
      this.log.firstElementChild!.remove()

    if (atEnd)
      this.log.scrollTop = this.log.scrollHeight
  }

  /** Take the chat off screen, e.g. while the editor is open */
  hide(): void {
    this.input.blur()
    this.element.hidden = true
  }

  show(): void {
    this.element.hidden = false
  }

  destroy(): void {
    this.document.removeEventListener('keydown', this.onDocumentKey)
    this.element.remove()
  }
}
