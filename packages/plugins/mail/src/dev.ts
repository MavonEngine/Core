import type { DevPlugin, DevPluginContext, PluginTool } from '@mavonengine/core/Plugins/types'
import type { InboxLocation } from './inboxFile'
import { setTimeout as delay } from 'node:timers/promises'
import { readInboxLocation } from './inboxFile'

/**
 * The plugin's dev entry: tools for AI assistants (`mavonengine mcp`) to read the dev inbox, so they can follow a sign
 * up, a password reset or anything else the game mails to its end. It runs in the client's Vite dev server and talks to
 * the MailDev the game server started, on this machine, through MailDev's REST API.
 */

/** A mail as MailDev's API gives it, the part the tools use */
interface MailDevAddress { address: string, name?: string }
interface MailDevSummary {
  id: string
  time: string
  read: boolean
  subject: string
  from: MailDevAddress[]
  to: MailDevAddress[]
  cc?: MailDevAddress[]
  attachmentCount: number
  preview: string
}
interface MailDevEmail extends Omit<MailDevSummary, 'attachmentCount' | 'preview'> {
  text?: string
  html?: string
  headers: Record<string, string | string[]>
  attachments: { filename: string, contentType: string, size?: number }[]
}

const REQUEST_TIMEOUT_MS = 5000
/** MailDev's largest page */
const PAGE = 200
const MAX_WAIT_SECONDS = 60
const POLL_MS = 500
/** Mail text sent to the model, in characters */
const MAX_TEXT = 20_000

const NO_INBOX = 'No dev inbox is running. It runs in the game server, in development, while no SMTP server or transport is set up, '
  + 'and only with maildev installed (npm i -D maildev) and "devInbox" not false in the plugin\'s options. Start the game with '
  + '`mavonengine dev`, or check the server log for why it didn\'t start. Without it, the game writes its mail to the server log'

const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const TAG_RE = /<[^>]*>/g
const BLOCK_END_RE = /<\/(?:p|div|tr|h\d|li)>|<br\s*\/?>/gi
const STYLE_RE = /<(style|script)[^>]*>[\s\S]*?<\/\1>/gi
const BLANK_LINES_RE = /\n\s*\n\s*\n/g
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/
const WEB_URL_RE = /^https?:\/\//i
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': '\'',
  '&nbsp;': ' ',
}
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|nbsp);/g

const decode = (text: string) => text.replace(ENTITY_RE, entity => ENTITIES[entity])

function address({ address, name }: MailDevAddress): string {
  return name
    ? `${name} <${address}>`
    : address
}

function addresses(list: MailDevAddress[] | undefined): string[] {
  return (list ?? []).map(address)
}

/** The mail's text, from its html when it has none */
function textOf(email: MailDevEmail): string {
  if (email.text?.trim())
    return email.text.trim()
  return decode((email.html ?? '')
    .replace(STYLE_RE, '')
    .replace(BLOCK_END_RE, '\n')
    .replace(TAG_RE, ''))
    .replace(BLANK_LINES_RE, '\n\n')
    .trim()
}

/** Every link in the mail, in the order they appear, without mailto: and anchors */
export function linksOf(email: Pick<MailDevEmail, 'text' | 'html'>): string[] {
  const links = new Set<string>()
  for (const [, href] of (email.html ?? '').matchAll(HREF_RE)) {
    const link = decode(href.trim())
    if (WEB_URL_RE.test(link))
      links.add(link)
  }
  for (const [link] of (email.text ?? '').matchAll(URL_RE))
    links.add(link.replace(TRAILING_PUNCTUATION_RE, ''))
  return [...links]
}

function sentTo(mail: Pick<MailDevSummary, 'to' | 'cc'>, to: string): boolean {
  const wanted = to.trim().toLowerCase()
  return [
    ...mail.to,
    ...(mail.cc ?? []),
  ].some(({ address }) => address.toLowerCase() === wanted)
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}

/** Talks to the MailDev the game server started, which it names in `INBOX_FILE` */
export class DevInboxClient {
  constructor(private readonly dataDir: string, private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  private location(): InboxLocation {
    const location = readInboxLocation(this.dataDir)
    if (!location)
      throw new Error(NO_INBOX)
    return location
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { api } = this.location()
    let res: Response
    try {
      res = await this.fetchImpl(`${api}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    }
    catch (err) {
      throw new Error(`The dev inbox at ${api} doesn't answer (${(err as Error).message}): the game server probably stopped. ${NO_INBOX}`)
    }
    if (res.status === 404 && path.startsWith('/email/'))
      throw new Error(`No mail ${path.split('/')[2]} in the dev inbox: it was deleted, or the id is wrong. mail_inbox lists the mail`)
    if (!res.ok)
      throw new Error(`The dev inbox answered ${res.status} to ${init.method ?? 'GET'} ${path}`)
    return await res.json() as T
  }

  /** The newest mail first, at most `PAGE`, matching MailDev's search: subject, addresses and text */
  async list(options: { search?: string, unread?: boolean } = {}): Promise<{ items: MailDevSummary[], total: number, storeTotal: number, unread: number }> {
    const params = new URLSearchParams({
      limit: String(PAGE),
      sort: 'desc',
    })
    if (options.search)
      params.set('search', options.search)
    if (options.unread)
      params.set('unread', 'true')
    return this.request(`/email/summary?${params}`)
  }

  /** One mail, which MailDev then marks read */
  get(id: string): Promise<MailDevEmail> {
    return this.request(`/email/${encodeURIComponent(id)}`)
  }

  async delete(id?: string): Promise<void> {
    await this.request(id
      ? `/email/${encodeURIComponent(id)}`
      : '/email/all', { method: 'DELETE' })
  }
}

function summary(mail: MailDevSummary) {
  return {
    id: mail.id,
    time: mail.time,
    read: mail.read,
    subject: mail.subject,
    from: addresses(mail.from),
    to: addresses(mail.to),
    ...(mail.cc?.length
      ? {
          cc: addresses(mail.cc),
        }
      : {}),
    attachments: mail.attachmentCount,
    preview: mail.preview,
  }
}

/** The tools the dev entry gives `mavonengine mcp`, as `mail_<name>` */
export function mailTools(inbox: DevInboxClient): PluginTool[] {
  const find = async (args: { to?: string, subject?: string, search?: string, unread?: boolean }) => {
    const { items, total, unread } = await inbox.list({ search: args.search ?? args.to, unread: args.unread })
    const subject = args.subject?.toLowerCase()
    return {
      total,
      unread,
      items: items.filter(mail => (!args.to || sentTo(mail, args.to)) && (!subject || mail.subject.toLowerCase().includes(subject))),
    }
  }

  return [
    {
      name: 'inbox',
      title: 'List the dev inbox',
      description: 'Lists the mail the game sent while developing, which goes to the dev inbox (MailDev) instead of out: newest first, '
        + 'with sender, recipients, subject and the start of the text. Use mail_read for the whole mail and its links. '
        + 'Mail is often queued and sent a moment later: mail_read can wait for it.',
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Only mail to (or cc) this address, e.g. the address a test account signed up with' },
          subject: { type: 'string', description: 'Only mail whose subject contains this, ignoring case' },
          search: { type: 'string', description: 'Words to find in the subject, addresses or text' },
          unread: { type: 'boolean', description: 'Only mail nobody opened yet, in the inbox or with mail_read' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: PAGE,
            default: 20,
          },
        },
      },
      readOnly: true,
      async run(args) {
        const found = await find({
          to: stringArg(args, 'to'),
          subject: stringArg(args, 'subject'),
          search: stringArg(args, 'search'),
          unread: args.unread === true,
        })
        const limit = typeof args.limit === 'number'
          ? Math.min(Math.max(1, Math.floor(args.limit)), PAGE)
          : 20
        return {
          inboxTotal: found.total,
          inboxUnread: found.unread,
          matched: found.items.length,
          mail: found.items.slice(0, limit).map(summary),
        }
      },
    },
    {
      name: 'read',
      title: 'Read a mail in the dev inbox',
      description: 'The whole of a mail in the dev inbox: sender, recipients, subject, its text (from the html when it has none) and every '
        + 'link in it, e.g. the link to verify an address or reset a password, to open next. Give the id from mail_inbox, or `to` '
        + 'and/or `subject` for the newest mail that matches. With `waitSeconds`, waits that long for such a mail to arrive, for mail '
        + 'the game queued a moment ago. Marks the mail read in the inbox.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'From mail_inbox' },
          to: { type: 'string', description: 'The newest mail to (or cc) this address' },
          subject: { type: 'string', description: 'The newest mail whose subject contains this, ignoring case' },
          waitSeconds: {
            type: 'number',
            minimum: 0,
            maximum: MAX_WAIT_SECONDS,
            default: 0,
            description: 'Wait for a matching mail to arrive, without id',
          },
          html: { type: 'boolean', description: 'Include the html too. Default false: the text and links are usually enough' },
        },
      },
      readOnly: true,
      async run(args) {
        let id = stringArg(args, 'id')
        const to = stringArg(args, 'to')
        const subject = stringArg(args, 'subject')
        if (!id && !to && !subject)
          throw new Error('Give id, or to and/or subject for the newest mail that matches')

        if (!id) {
          const wait = typeof args.waitSeconds === 'number'
            ? Math.min(Math.max(0, args.waitSeconds), MAX_WAIT_SECONDS)
            : 0
          const until = Date.now() + wait * 1000
          for (;;) {
            id = (await find({ to, subject })).items[0]?.id
            if (id || Date.now() >= until)
              break
            await delay(POLL_MS)
          }
          if (!id) {
            const which = [to && `to ${to}`, subject && `with "${subject}" in the subject`].filter(Boolean).join(' ')
            throw new Error(`No mail ${which} in the dev inbox${wait
              ? ` after waiting ${wait}s`
              : ''}. Mail the game queued is sent `
              + 'by the server\'s queue, which may still be trying: see the server log. mail_inbox lists what arrived')
          }
        }

        const email = await inbox.get(id)
        const text = textOf(email)
        return {
          id: email.id,
          time: email.time,
          subject: email.subject,
          from: addresses(email.from),
          to: addresses(email.to),
          ...(email.cc?.length
            ? {
                cc: addresses(email.cc),
              }
            : {}),
          text: text.length > MAX_TEXT
            ? `${text.slice(0, MAX_TEXT)}…`
            : text,
          ...(text.length > MAX_TEXT
            ? { textTruncated: true }
            : {}),
          links: linksOf(email),
          attachments: email.attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })),
          ...(args.html === true
            ? { html: email.html ?? null }
            : {}),
        }
      },
    },
    {
      name: 'clear',
      title: 'Delete mail from the dev inbox',
      description: 'Deletes one mail from the dev inbox, by its id from mail_inbox, or all of it without one. Only the dev inbox: no mail '
        + 'was sent anywhere. E.g. to start a test with an empty inbox.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The mail to delete. Leave it out to delete all mail in the inbox' },
        },
      },
      destructive: true,
      async run(args) {
        const id = stringArg(args, 'id')
        if (id) {
          await inbox.delete(id)
          return {
            deleted: [id],
          }
        }
        const { storeTotal } = await inbox.list()
        await inbox.delete()
        return { deleted: storeTotal }
      },
    },
  ]
}

export function createDevPlugin(fetchImpl?: typeof globalThis.fetch): DevPlugin {
  return {
    name: 'Mail',
    mcpTools: (ctx: DevPluginContext) => mailTools(new DevInboxClient(ctx.dataDir, fetchImpl)),
  }
}

export default createDevPlugin()
