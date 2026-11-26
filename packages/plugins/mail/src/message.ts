/** A mailbox: `player@example.com`, `Player One <player@example.com>`, or the same as an object */
export type Address = string | MailAddress

export interface MailAddress {
  address: string
  name?: string
}

/**
 * A mail ready to send, what a transport gets. Plain JSON, so it can wait on the queue and survive a restart.
 */
export interface MailMessage {
  from?: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  bcc?: MailAddress[]
  replyTo?: MailAddress
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
}

/** A mail as the game writes it: addresses in either form, and one recipient without an array */
export interface MailInput {
  from?: Address
  to: Address | Address[]
  cc?: Address | Address[]
  bcc?: Address | Address[]
  replyTo?: Address
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  /** Send it in the plugin's layout. Defaults to the `layout` option, true */
  layout?: boolean
  /** The line inboxes show next to the subject, for the layout */
  preheader?: string
}

/** A mail that can't be sent as it is: no recipient, no subject, an address that is none */
export class MailError extends Error {
  override name = 'MailError'
}

const ADDRESS_RE = /^[^\s@<>",;]+@[^\s",;<>@][^\s",.;<>@]*\.[^\s",;<>@]+$/
const LINE_BREAK_RE = /[\r\n]/
const HEADER_NAME_RE = /^[!#$%&'*+\-.^\w`|~]+$/
/** Headers the transport writes from the message's own fields */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'content-type',
  'content-transfer-encoding',
  'mime-version',
])

/** `Name <address>` or a bare address, as an object. Throws a MailError for anything else */
export function parseAddress(address: Address, field = 'address'): MailAddress {
  let parsed: MailAddress
  if (typeof address === 'string') {
    parsed = splitNamed(address)
  }
  else if (address && typeof address === 'object' && typeof address.address === 'string') {
    parsed = {
      address: address.address.trim(),
      name: typeof address.name === 'string' && address.name.trim()
        ? address.name.trim()
        : undefined,
    }
  }
  else {
    throw new MailError(`${field} is no address: ${JSON.stringify(address)}`)
  }

  if (!ADDRESS_RE.test(parsed.address))
    throw new MailError(`${field} is no address: ${JSON.stringify(parsed.address)}`)
  if (parsed.name !== undefined && LINE_BREAK_RE.test(parsed.name))
    throw new MailError(`The name of ${field} has a line break`)

  return parsed.name === undefined
    ? { address: parsed.address }
    : parsed
}

/** `Name <address>` or `"Name" <address>` into its parts, a bare address as it is. Without a regex: it is player input */
function splitNamed(value: string): MailAddress {
  const text = value.trim()
  const open = text.lastIndexOf('<')
  if (open < 0 || !text.endsWith('>'))
    return { address: text }

  let name = text.slice(0, open).trim()
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"'))
    name = name.slice(1, -1).trim()
  return {
    address: text.slice(open + 1, -1).trim(),
    name: name || undefined,
  }
}

function addresses(value: Address | Address[] | undefined, field: string): MailAddress[] | undefined {
  if (value === undefined)
    return undefined
  const list = (Array.isArray(value)
    ? value
    : [value]).map(address => parseAddress(address, field))
  return list.length ? list : undefined
}

/** The mailbox as one header value: `"Player One" <player@example.com>` */
export function formatAddress({ address, name }: MailAddress): string {
  return name
    ? `"${name.replace(/["\\]/g, '\\$&')}" <${address}>`
    : address
}

/**
 * Check a mail and bring it into the shape transports get. Throws a MailError for what no transport could send,
 * so the game hears of it when it sends, rather than in the log when the queue runs it.
 */
export function toMessage(input: MailInput, defaultFrom?: MailAddress): MailMessage {
  if (!input || typeof input !== 'object')
    throw new MailError('A mail needs to, subject and text or html')

  const to = addresses(input.to, 'to')
  if (!to)
    throw new MailError('A mail needs someone to send it to')

  if (typeof input.subject !== 'string' || !input.subject.trim())
    throw new MailError('A mail needs a subject')
  if (LINE_BREAK_RE.test(input.subject))
    throw new MailError('The subject of a mail can\'t have a line break')

  const text = typeof input.text === 'string' && input.text
    ? input.text
    : undefined
  const html = typeof input.html === 'string' && input.html
    ? input.html
    : undefined
  if (text === undefined && html === undefined)
    throw new MailError('A mail needs text or html')

  let headers: Record<string, string> | undefined
  if (input.headers) {
    headers = {}
    for (const [name, value] of Object.entries(input.headers)) {
      if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase()))
        throw new MailError(`A mail can't have a ${JSON.stringify(name)} header`)
      if (typeof value !== 'string' || LINE_BREAK_RE.test(value))
        throw new MailError(`The ${name} header must be text without line breaks`)
      headers[name] = value
    }
  }

  const message: MailMessage = {
    to,
    subject: input.subject.trim(),
  }
  const from = input.from !== undefined
    ? parseAddress(input.from, 'from')
    : defaultFrom
  if (from)
    message.from = from
  const cc = addresses(input.cc, 'cc')
  if (cc)
    message.cc = cc
  const bcc = addresses(input.bcc, 'bcc')
  if (bcc)
    message.bcc = bcc
  if (input.replyTo !== undefined)
    message.replyTo = parseAddress(input.replyTo, 'replyTo')
  if (text !== undefined)
    message.text = text
  if (html !== undefined)
    message.html = html
  if (headers && Object.keys(headers).length)
    message.headers = headers
  return message
}
