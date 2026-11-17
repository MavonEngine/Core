import type { ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { DispatchOptions } from '@mavonengine/core/Queue/Queue'
import type { Address, MailAddress, MailInput, MailMessage } from './message'
import type { MailTransport, NodemailerTransport, SentMail } from './transports'
import process from 'node:process'
import Job from '@mavonengine/core/Queue/Job'
import { LAYOUT_FILE, LayoutFile, renderLayout, textToHtml } from './layout'
import { formatAddress, MailError, parseAddress, toMessage } from './message'
import { logTransport, nodemailerTransport } from './transports'

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
  /** The game's name, for the layout. Defaults to the sender's name */
  appName?: string
  /** More values for the layout, e.g. `{ "footer": "You get this because you play My Game." }` */
  layoutData: Record<string, string>
}

const DEFAULTS: MailOptions = { queued: true, queue: 'default', tries: 3, backoffMs: [10_000, 60_000], layout: true, layoutData: {} }

export function parseOptions(raw: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): MailOptions {
  const options: MailOptions = {
    queued: typeof raw.queued === 'boolean' ? raw.queued : DEFAULTS.queued,
    queue: typeof raw.queue === 'string' && raw.queue ? raw.queue : DEFAULTS.queue,
    tries: typeof raw.tries === 'number' && raw.tries >= 1 ? Math.floor(raw.tries) : DEFAULTS.tries,
    backoffMs: typeof raw.backoffMs === 'number' || (Array.isArray(raw.backoffMs) && raw.backoffMs.every(ms => typeof ms === 'number'))
      ? raw.backoffMs as number | number[]
      : DEFAULTS.backoffMs,
    layout: typeof raw.layout === 'boolean' ? raw.layout : DEFAULTS.layout,
    layoutData: {},
  }

  if (typeof raw.appName === 'string' && raw.appName)
    options.appName = raw.appName
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
    auth: smtp.user ? { user: smtp.user, pass: password ?? '' } : undefined,
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
    appName: state.options.appName ?? message.from?.name ?? '',
    year: String(new Date().getFullYear()),
  })
}

async function deliver(state: MailState, message: MailMessage): Promise<MailResult> {
  const transport = state.transport
  if (!message.from && transport.name !== 'log')
    throw new MailError(`No sender: set "from" in the options of ${PACKAGE} or ${FROM_ENV}`)

  const sent = await transport.send(message) as SentMail | undefined
  if (transport.name !== 'log')
    state.ctx.logger?.info(`Mail sent through ${transport.name} to ${message.to.map(formatAddress).join(', ')}: ${message.subject}`)
  return { queued: false, transport: transport.name, ...(sent?.messageId ? { messageId: sent.messageId } : {}) }
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
  const state = { ctx, options, from, transport, layout } as MailState
  const SendMail = sendMailJob(state)
  ctx.queue.register(SendMail)

  const send = async (input: MailInput, sendOptions: SendOptions = {}, mailableQueued?: boolean): Promise<MailResult> => {
    const message = toMessage(input, state.from)
    if (!message.from && state.transport.name !== 'log')
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
      cc: (...more) => pending(to, [...cc, ...more], bcc),
      bcc: (...more) => pending(to, cc, [...bcc, ...more]),
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
    if (state.transport.name === 'log')
      ctx.logger?.info(`Mail: no transport set up yet, mail is written to the log. Set "smtp" in the options of ${PACKAGE}, or call useTransport()`)
    else
      ctx.logger?.info(`Mail: sending through ${state.transport.name}`)
    if (!state.from)
      ctx.logger?.warn(`Mail: no sender set. Set "from" in the options of ${PACKAGE} or ${FROM_ENV}, or mail needs one of its own`)
  },
  async destroy(ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    registry().delete(ctx.server)
    // The server stopped its queue before this, but a mail may still be on its way: close the transport after it.
    // stop() again only waits for the jobs that run
    await ctx.queue.stop()
    await state?.transport.close?.()
  },
} satisfies ServerPlugin
