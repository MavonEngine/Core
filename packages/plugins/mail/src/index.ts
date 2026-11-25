import type { ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { DispatchOptions } from '@mavonengine/core/Queue/Queue'
import type { Express } from 'express'
import type { DevInbox } from './devInbox'
import type { InboxLocation } from './inboxFile'
import type { Address, MailAddress, MailInput, MailMessage } from './message'
import type { MailTransport, NodemailerTransport, SentMail } from './transports'
import { join } from 'node:path'
import process from 'node:process'
import Job from '@mavonengine/core/Queue/Job'
import { DEV_INBOX_PAGE, DEV_INBOX_THEME_JS, DEV_INBOX_THEME_SCRIPT, devInboxTransport, devInboxWanted, proxyToInbox, refuseInboxUpgrades, registerInboxPage, startDevInbox } from './devInbox'
import { mailDataDir, removeInboxLocation, writeInboxLocation } from './inboxFile'
import { LAYOUT_FILE, LayoutFile, renderLayout, textToHtml } from './layout'
import { formatAddress, MailError, parseAddress, toMessage } from './message'
import { logTransport, nodemailerTransport } from './transports'

export type { DevInbox, DevInboxOptions } from './devInbox'
export { DEV_INBOX_CSP, devInboxTransport, devInboxWanted, loadMailDev, proxyToInbox, startDevInbox } from './devInbox'
export { DEFAULT_LAYOUT_PATH, escapeHtml, LAYOUT_FILE, renderLayout, textToHtml } from './layout'

export type { Address, MailAddress, MailInput, MailMessage } from './message'
export { formatAddress, MailError, parseAddress, toMessage } from './message'
export type { MailTransport, NodemailerTransport, SentMail } from './transports'
export { logTransport, memoryTransport, nodemailerTransport } from './transports'

export const PACKAGE = '@mavonengine/mail'

/** Set the default sender, overriding `from` in the options */
export const FROM_ENV = 'MAVONENGINE_MAIL_FROM'
/** An SMTP URL with its credentials, `smtps://user:password@smtp.example.com`, overriding `smtp` in the options */
export const SMTP_URL_ENV = 'MAVONENGINE_MAIL_SMTP_URL'
/** The SMTP password, which doesn't belong in mavonengine.json */
export const SMTP_PASSWORD_ENV = 'MAVONENGINE_MAIL_SMTP_PASSWORD'

export interface SmtpOptions {
  host: string
  /** Default 587, or 465 with `secure` */
  port?: number
  /** TLS from the start (port 465). Without, the connection is upgraded with STARTTLS when the server offers it */
  secure?: boolean
  user?: string
}

export interface MailOptions {
  /** The sender of mail that doesn't name one. `MAVONENGINE_MAIL_FROM` overrides it */
  from?: Address
  /**
   * The SMTP server to send through: options, or a URL without the password. The password comes from
   * `MAVONENGINE_MAIL_SMTP_PASSWORD`, or put all of it in `MAVONENGINE_MAIL_SMTP_URL`. Without SMTP and without a
   * transport from `useTransport()`, mail is written to the log.
   */
  smtp?: SmtpOptions | string
  /** Queue mail instead of sending it in the call, unless a mail says otherwise. Default true */
  queued: boolean
  /** The queue mail goes on. Default `default` */
  queue: string
  /** How often a queued mail is tried before it counts as failed. Default 3 */
  tries: number
  /** Wait before trying a mail again, in ms, see the queue's `backoffMs`. Default 10s, then 1 minute */
  backoffMs: number | number[]
  /**
   * Send mail in the layout: the plugin's, or the project's after `mavonengine asset:publish @mavonengine/mail`.
   * A mail with only text gets html made from it. Default true
   */
  layout: boolean
  /** More values for the layout, e.g. `{ "footer": "You get this because you play My Game." }` */
  layoutData: Record<string, string>
  /**
   * In development, while no SMTP server or transport is set up, send mail to a MailDev inbox shown in the admin
   * panel (`/admin/mail/`) instead of only writing it to the log. Needs `maildev` installed, e.g. as a dev
   * dependency. Never in production or tests. Default true
   */
  devInbox: boolean
}

const DEFAULTS: MailOptions = {
  queued: true,
  queue: 'default',
  tries: 3,
  backoffMs: [10_000, 60_000],
  layout: true,
  layoutData: {},
  devInbox: false,
}

/** Transports nobody receives mail from, so mail doesn't need a sender */
const NOWHERE_TRANSPORTS = new Set(['log', 'maildev'])

/** Sender of mail in the dev inbox that names none */
const DEV_FROM = 'game@localhost'

export function parseOptions(raw: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): MailOptions {
  const options: MailOptions = {
    queued: typeof raw.queued === 'boolean'
      ? raw.queued
      : DEFAULTS.queued,
    queue: typeof raw.queue === 'string' && raw.queue
      ? raw.queue
      : DEFAULTS.queue,
    tries: typeof raw.tries === 'number' && raw.tries >= 1
      ? Math.floor(raw.tries)
      : DEFAULTS.tries,
    backoffMs: typeof raw.backoffMs === 'number' || (Array.isArray(raw.backoffMs) && raw.backoffMs.every(ms => typeof ms === 'number'))
      ? raw.backoffMs as number | number[]
      : DEFAULTS.backoffMs,
    layout: typeof raw.layout === 'boolean'
      ? raw.layout
      : DEFAULTS.layout,
    layoutData: {},
    devInbox: devInboxWanted(raw.devInbox, env),
  }

  if (raw.layoutData && typeof raw.layoutData === 'object') {
    for (const [name, value] of Object.entries(raw.layoutData)) {
      if (typeof value === 'string' || typeof value === 'number')
        options.layoutData[name] = String(value)
    }
  }

  const from = env[FROM_ENV] || raw.from
  if (from !== undefined)
    options.from = from as Address

  const smtp = env[SMTP_URL_ENV] || raw.smtp
  if (typeof smtp === 'string' && smtp)
    options.smtp = smtp
  else if (smtp && typeof smtp === 'object' && typeof (smtp as SmtpOptions).host === 'string')
    options.smtp = smtp as SmtpOptions

  return options
}

/** The nodemailer config of the SMTP options, with the password from the environment */
export function smtpConfig(smtp: SmtpOptions | string, env: NodeJS.ProcessEnv = process.env): NodemailerTransport {
  const password = env[SMTP_PASSWORD_ENV]
  if (typeof smtp === 'string') {
    if (!password || env[SMTP_URL_ENV])
      return smtp
    const url = new URL(smtp)
    url.password = password
    return url.toString()
  }

  const secure = smtp.secure ?? smtp.port === 465
  return {
    host: smtp.host,
    port: smtp.port ?? (secure ? 465 : 587),
    secure,
    auth: smtp.user
      ? { user: smtp.user, pass: password ?? '' }
      : undefined,
  }
}

/**
 * A mail the game sends, written as a class:
 *
 * ```ts
 * class Welcome extends Mailable {
 *   constructor(private name: string) { super() }
 *   subject() { return `Welcome, ${this.name}` }
 *   text() { return `Good to have you, ${this.name}.` }
 * }
 *
 * await mail.to(email).send(new Welcome(name))
 * ```
 *
 * It is rendered when it is sent, so what waits on the queue is the finished mail.
 */
export abstract class Mailable {
  /** Queue it, or send it in the call. Defaults to the plugin's `queued` option */
  queued?: boolean
  /** Send it in the layout. Defaults to the plugin's `layout` option, true */
  layout?: boolean
  from?: Address
  replyTo?: Address
  abstract subject(): string
  text?(): string
  /** The mail's html: what goes inside the layout, not a whole page */
  html?(): string
  /** The line inboxes show next to the subject */
  preheader?(): string
  headers?(): Record<string, string>
}

/** What `send()` did: queued the mail, with the id of its job, or sent it */
export type MailResult = { queued: true, jobId: string } | { queued: false, transport: string, messageId?: string }

export interface SendOptions {
  /** Queue it, or send it in the call. Defaults to the mailable's, else the plugin's `queued` option */
  queued?: boolean
  /** Wait this long before sending it, in ms. Queues it */
  delayMs?: number
}

/** A mail to someone, waiting for what to send: `mail.to(email).cc(other).send(new Welcome())` */
export interface PendingMail {
  cc(...cc: Address[]): PendingMail
  bcc(...bcc: Address[]): PendingMail
  /** Send it: queued unless the mailable, the options or the plugin say otherwise */
  send(mailable: Mailable, options?: SendOptions): Promise<MailResult>
  /** Send it now, in this call, through the transport. Rejects when the transport does */
  sendNow(mailable: Mailable): Promise<MailResult>
}

/**
 * What the mail plugin gives other plugins as `ctx.plugin('@mavonengine/mail')`, and the game as `mail(server)`.
 */
export interface MailApi {
  to(...to: Address[]): PendingMail
  /** Send a mail written out, e.g. one a notification built. Throws a MailError when it can't be sent as it is */
  send(mail: MailInput, options?: SendOptions): Promise<MailResult>
  /** Send mail through `transport` from now on, e.g. from a provider's plugin. The one before is closed */
  useTransport(transport: MailTransport): void
  /** Send mail through anything nodemailer's `createTransport()` takes: SMTP options or URL, `{ SES: … }`, … */
  useNodemailer(config: NodemailerTransport, name?: string): void
  /** Name of the transport mail goes through now, `log` while none is set up */
  readonly transport: string
}

declare module '@mavonengine/core/Plugins/types' {
  interface ServerPluginApis {
    '@mavonengine/mail': MailApi
  }
}

interface MailState {
  ctx: ServerPluginContext
  options: MailOptions
  from?: MailAddress
  transport: MailTransport
  layout: LayoutFile
  /** Whether a layout that couldn't be read was logged */
  layoutFailed?: boolean
  api: MailApi
  /** MailDev, when the dev inbox is wanted: undefined once it turned out the project doesn't have it */
  inbox?: Promise<DevInbox | undefined>
  /** Its web port, once it runs */
  inboxPort?: number
  /** Where its UI is served, `/admin/mail/inbox` */
  inboxPath?: string
  /** What the server wrote for the dev entry's tools to find the inbox, see `INBOX_FILE` */
  inboxLocation?: InboxLocation
}

const STATES = Symbol.for('mavonengine.mail.states')

/** Kept on globalThis, so the game finds the plugin's mail with `mail(server)` even with its own copy of this file */
function registry(): WeakMap<object, MailState> {
  return ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, MailState>
}

/** The mail of a server that runs the mail plugin, undefined for one that doesn't */
export function mail(server: object): MailApi | undefined {
  return registry().get(server)?.api
}

/** The job a queued mail waits on the queue as. Made per server, as it sends through that server's transport */
function sendMailJob(state: MailState) {
  return class SendMail extends Job<MailMessage> {
    static jobName = 'mail:send'
    tries = state.options.tries
    backoffMs = state.options.backoffMs

    async handle() {
      await deliver(state, this.data)
    }
  }
}

/** Put the mail's html, or its text made html, in the layout. A layout that can't be read leaves the mail as it is */
function applyLayout(state: MailState, message: MailMessage, preheader?: string) {
  let layout: string
  try {
    layout = state.layout.read()
    state.layoutFailed = false
  }
  catch (err) {
    if (!state.layoutFailed)
      state.ctx.logger?.error(`Mail: could not read the layout ${state.layout.path}, sending mail without it: ${(err as Error).message}`)
    state.layoutFailed = true
    return
  }

  message.html = renderLayout(layout, {
    ...state.options.layoutData,
    content: message.html ?? textToHtml(message.text!),
    subject: message.subject,
    preheader,
    appName: state.ctx.appName ?? message.from?.name ?? '',
    appUrl: state.ctx.appUrl ?? '',
    year: String(new Date().getFullYear()),
  })
}

async function deliver(state: MailState, message: MailMessage): Promise<MailResult> {
  const transport = state.transport
  if (!message.from && !NOWHERE_TRANSPORTS.has(transport.name))
    throw new MailError(`No sender: set "from" in the options of ${PACKAGE} or ${FROM_ENV}`)

  const sent = await transport.send(message) as SentMail | undefined
  if (transport.name !== 'log')
    state.ctx.logger?.info(`Mail sent through ${transport.name} to ${message.to.map(formatAddress).join(', ')}: ${message.subject}`)
  return {
    queued: false,
    transport: transport.name,
    ...(sent?.messageId
      ? { messageId: sent.messageId }
      : {}),
  }
}

function createState(ctx: ServerPluginContext): MailState {
  const options = parseOptions(ctx.options)
  let from: MailAddress | undefined
  if (options.from !== undefined) {
    try {
      from = parseAddress(options.from, 'from')
    }
    catch (err) {
      ctx.logger?.error(`Mail: ${(err as Error).message}, so mail without a sender of its own can't be sent`)
    }
  }

  let transport: MailTransport = logTransport(ctx.logger)
  if (options.smtp) {
    try {
      transport = nodemailerTransport(smtpConfig(options.smtp), 'smtp')
    }
    catch (err) {
      ctx.logger?.error(`Mail: the SMTP options don't work, writing mail to the log: ${(err as Error).message}`)
    }
  }

  const layout = new LayoutFile(() => ctx.publishedFile?.(LAYOUT_FILE))
  const state = {
    ctx,
    options,
    from,
    transport,
    layout,
  } as MailState

  if (!options.smtp && options.devInbox)
    openDevInbox(state)

  const SendMail = sendMailJob(state)
  ctx.queue.register(SendMail)

  const send = async (input: MailInput, sendOptions: SendOptions = {}, mailableQueued?: boolean): Promise<MailResult> => {
    const message = toMessage(input, state.from)
    if (!message.from && !NOWHERE_TRANSPORTS.has(state.transport.name))
      throw new MailError(`No sender: set "from" in the options of ${PACKAGE} or ${FROM_ENV}`)
    if (input.layout ?? state.options.layout)
      applyLayout(state, message, input.preheader)

    const queued = (sendOptions.delayMs ?? 0) > 0 || (sendOptions.queued ?? mailableQueued ?? state.options.queued)
    if (!queued)
      return deliver(state, message)

    const dispatch: DispatchOptions = { queue: state.options.queue }
    if (sendOptions.delayMs)
      dispatch.delayMs = sendOptions.delayMs
    return { queued: true, jobId: await ctx.queue.dispatch(new SendMail(message), dispatch) }
  }

  const pending = (to: Address[], cc: Address[] = [], bcc: Address[] = []): PendingMail => {
    const render = (mailable: Mailable): MailInput => ({
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      from: mailable.from,
      replyTo: mailable.replyTo,
      subject: mailable.subject(),
      text: mailable.text?.(),
      html: mailable.html?.(),
      headers: mailable.headers?.(),
      layout: mailable.layout,
      preheader: mailable.preheader?.(),
    })
    return {
      cc: (...more) => pending(to, [
        ...cc,
        ...more,
      ], bcc),
      bcc: (...more) => pending(to, cc, [
        ...bcc,
        ...more,
      ]),
      send: (mailable, sendOptions) => send(render(mailable), sendOptions, mailable.queued),
      sendNow: mailable => send(render(mailable), { queued: false }),
    }
  }

  const use = (next: MailTransport) => {
    const before = state.transport
    state.transport = next
    if (before !== next)
      void Promise.resolve(before.close?.()).catch(() => {})
    ctx.logger?.info(`Mail: sending through ${next.name}`)
  }

  state.api = {
    to: (...to) => pending(to),
    send: (input, sendOptions) => send(input, sendOptions),
    useTransport: use,
    useNodemailer: (config, name) => use(nodemailerTransport(config, name)),
    get transport() {
      return state.transport.name
    },
  }
  return state
}

/**
 * Start MailDev and send mail into it until another transport is set up. Falls back to the log when the project
 * doesn't have maildev or it can't start.
 */
function openDevInbox(state: MailState) {
  const { ctx } = state
  const fallback = state.transport
  // Without an admin panel (a core from before it), MailDev's UI is at the root of its own port
  state.inboxPath = ctx.admin
    ? ctx.admin.url(`${DEV_INBOX_PAGE}/inbox`)
    : ''
  state.inbox = startDevInbox({
    basePath: state.inboxPath,
    mailDirectory: ctx.projectRoot
      ? join(ctx.projectRoot, '.mavonengine', 'maildev')
      : undefined,
  })
  const transport = devInboxTransport(state.inbox, fallback, () => DEV_FROM)
  state.transport = transport

  state.inbox.then((inbox) => {
    if (!inbox) {
      ctx.logger?.info(`Mail: install maildev (npm i -D maildev) to see the mail the game sends in a dev inbox in the admin panel. Until then it is written to the log`)
      if (state.transport === transport)
        state.transport = fallback
      return
    }
    state.inboxPort = inbox.webPort
    if (ctx.projectRoot) {
      try {
        state.inboxLocation = writeInboxLocation(mailDataDir(ctx.projectRoot), inbox.webPort, state.inboxPath ?? '')
      }
      catch (err) {
        ctx.logger?.warn(`Mail: AI assistants won't find the dev inbox, its address could not be written: ${(err as Error).message}`)
      }
    }
    const where = ctx.admin
      ? `${ctx.admin.url(DEV_INBOX_PAGE)}/ in the admin panel`
      : `http://127.0.0.1:${inbox.webPort}/`
    ctx.logger?.info(`Mail: no transport set up, mail goes to the dev inbox at ${where}`)
  }, (err: unknown) => {
    ctx.logger?.error(`Mail: the dev inbox (MailDev) could not start, writing mail to the log: ${(err as Error)?.message ?? err}`)
    if (state.transport === transport)
      state.transport = fallback
  })
}

export default {
  name: 'Mail',
  api(ctx: ServerPluginContext): MailApi {
    const state = createState(ctx)
    registry().set(ctx.server, state)
    return state.api
  },
  setup(ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    if (!state)
      return
    if (state.transport.name === 'maildev')
      return
    if (state.transport.name === 'log')
      ctx.logger?.info(`Mail: no transport set up yet, mail is written to the log. Set "smtp" in the options of ${PACKAGE}, or call useTransport()`)
    else
      ctx.logger?.info(`Mail: sending through ${state.transport.name}`)
    if (!state.from)
      ctx.logger?.warn(`Mail: no sender set. Set "from" in the options of ${PACKAGE} or ${FROM_ENV}, or mail needs one of its own`)
  },
  http(app: Express, ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    if (!state?.inbox || !ctx.admin || !state.inboxPath)
      return

    const inboxPath = state.inboxPath
    registerInboxPage(ctx.admin, inboxPath)
    // Under the admin panel's path, so behind its login
    const themeScript = `${inboxPath}/${DEV_INBOX_THEME_SCRIPT}`
    app.get(themeScript, (_req, res) => void res.type('text/javascript').send(DEV_INBOX_THEME_JS))
    app.use(inboxPath, proxyToInbox(() => state.inboxPort, { headScript: themeScript }))
    refuseInboxUpgrades(ctx.server.http?.server, inboxPath)
    // The inbox polls for new mail, which would bury everything else on the dashboard's HTTP tab
    ctx.server.requests?.ignorePrefix?.(`${inboxPath}/`)
  },
  async destroy(ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    registry().delete(ctx.server)
    // The server stopped its queue before this, but a mail may still be on its way: close the transport after it.
    // stop() again only waits for the jobs that run
    await ctx.queue.stop()
    await state?.transport.close?.()
    const inbox = await state?.inbox?.catch(() => undefined)
    if (state?.inboxLocation && ctx.projectRoot) {
      try {
        removeInboxLocation(mailDataDir(ctx.projectRoot), state.inboxLocation)
      }
      catch {}
    }
    await inbox?.stop().catch(() => {})
  },
} satisfies ServerPlugin
