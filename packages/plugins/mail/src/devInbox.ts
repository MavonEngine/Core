import type { AdminApi } from '@mavonengine/core/Plugins/types'
import type { Request, RequestHandler, Response } from 'express'
import type { IncomingHttpHeaders, Server as NodeServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { MailMessage } from './message'
import type { MailTransport, SentMail } from './transports'
import { Buffer } from 'node:buffer'
import { request as httpRequest } from 'node:http'
import { nodemailerTransport } from './transports'

/**
 * The dev inbox: MailDev (https://maildev.github.io/maildev/) running inside the game server in development. Mail the
 * game sends goes to MailDev's SMTP server on a local port instead of out, and its web UI is shown in the admin panel,
 * proxied from `/admin/mail/inbox/` behind the panel's login. MailDev serves its UI with Fastify on a port of its own,
 * which can't be mounted into Express: proxying to it is how MailDev's docs put it behind another server.
 *
 * `maildev` is an optional peer dependency: a project installs it as a dev dependency to get the inbox. It is never
 * started in production.
 */

/** Where the dev inbox's UI is in the admin panel */
export const DEV_INBOX_PAGE = 'mail'

/** The part of a running MailDev the plugin uses */
export interface DevInbox {
  smtpPort: number
  webPort: number
  stop(): Promise<void>
}

export interface DevInboxOptions {
  /** URL path MailDev's UI and API are served under, e.g. `/admin/mail/inbox`. `''` for the root of its own port */
  basePath: string
  /** Where mail is kept, so it survives a restart of the dev server. Default: MailDev's, in the temp directory */
  mailDirectory?: string
}

interface MailDevModule {
  MailDev: new (config: Record<string, unknown>) => {
    start(): Promise<{ smtp: { getAddress(): { port: number } }, api?: { getPort(): number | null } }>
    stop(): Promise<void>
  }
}

/** Import maildev, undefined when the project doesn't have it */
export async function loadMailDev(load: () => Promise<unknown> = () => import('maildev')): Promise<MailDevModule | undefined> {
  try {
    const mod = await load() as Partial<MailDevModule> & { default?: Partial<MailDevModule> }
    return (mod.MailDev ? mod : mod.default) as MailDevModule | undefined
  }
  catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
      return undefined
    throw err
  }
}

/** Whether the dev inbox runs where the server runs: only in development, never in production or tests */
export function devInboxWanted(option: unknown, env: Record<string, string | undefined>): boolean {
  if (option === false)
    return false
  const mode = env.NODE_ENV
  return mode === undefined || mode === '' || mode === 'development'
}

/**
 * Start MailDev on free ports of this machine only. Resolves undefined when the project doesn't have maildev.
 */
export async function startDevInbox(options: DevInboxOptions, load?: () => Promise<unknown>): Promise<DevInbox | undefined> {
  const mod = await loadMailDev(load)
  if (!mod)
    return undefined

  const maildev = new mod.MailDev({
    smtp: 0,
    ip: '127.0.0.1',
    web: 0,
    webIp: '127.0.0.1',
    basePathname: options.basePath || '/',
    silent: true,
    ...(options.mailDirectory
      ? { mailDirectory: options.mailDirectory }
      : {}),
  })
  const servers = await maildev.start()
  const webPort = servers.api?.getPort()
  if (!webPort) {
    await maildev.stop()
    throw new Error('MailDev started without its web server')
  }
  return {
    smtpPort: servers.smtp.getAddress().port,
    webPort,
    stop: () => maildev.stop(),
  }
}

/**
 * Sends mail into the dev inbox. Mail that is sent before MailDev runs waits for it; if MailDev couldn't start, it goes
 * to `fallback` (the log) instead. A mail without a sender gets one, since nobody receives it.
 */
export function devInboxTransport(inbox: Promise<DevInbox | undefined>, fallback: MailTransport, defaultFrom: () => string): MailTransport {
  let smtp: MailTransport | undefined
  let smtpFor: number | undefined
  return {
    name: 'maildev',
    async send(message: MailMessage): Promise<SentMail | void> {
      const running = await inbox.catch(() => undefined)
      if (!running)
        return fallback.send(message)
      if (!smtp || smtpFor !== running.smtpPort) {
        smtp = nodemailerTransport({
          host: '127.0.0.1',
          port: running.smtpPort,
          secure: false,
          ignoreTLS: true,
        }, 'maildev')
        smtpFor = running.smtpPort
      }
      return smtp.send(message.from
        ? message
        : {
            ...message,
            from: {
              address: defaultFrom(),
              name: '',
            },
          })
    },
    close: () => smtp?.close?.(),
  }
}

/** Where the script that makes the inbox dark by default is served, under the inbox's path */
export const DEV_INBOX_THEME_SCRIPT = '_mavonengine/theme.js'

/** Key MailDev's UI keeps its settings under in localStorage, with zustand's persist */
const MAILDEV_UI_STORAGE = 'maildev-ui-storage'

/**
 * Makes MailDev's UI start dark, like the admin panel, instead of light: it keeps the theme in localStorage, so this
 * stores `dark` before the UI reads it, only when nothing is stored yet. A viewer who picks light keeps it.
 * A classic script in the head, so it runs before the UI's module script.
 */
export const DEV_INBOX_THEME_JS = `try {
  if (!localStorage.getItem('${MAILDEV_UI_STORAGE}'))
    localStorage.setItem('${MAILDEV_UI_STORAGE}', JSON.stringify({ state: { theme: 'dark' }, version: 0 }))
}
catch {}
document.documentElement.classList.add('dark')
`

const HEAD_RE = /<head(\s[^>]*)?>/i

/** Headers of MailDev's answers that the proxy doesn't pass on: its own framing rules and CORS, and hop-by-hop ones */
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'x-frame-options',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
])

/**
 * The inbox is framed by the admin page, so it may be framed by this origin. Its `<base>` tag sets where its files
 * are. Mail html is shown in a sandboxed frame without scripts that keeps this policy, so it allows inline styles and
 * pictures from anywhere, which mail is made of.
 */
export const DEV_INBOX_CSP = 'default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src * data: blob:; font-src * data:; connect-src \'self\'; frame-src \'self\'; object-src \'none\'; base-uri \'self\'; form-action \'self\'; frame-ancestors \'self\''

/**
 * Pass requests on to MailDev's web server, keeping their path, which MailDev's `basePathname` matches.
 */
export function proxyToInbox(webPort: () => number | undefined, options: { headScript?: string } = {}): RequestHandler {
  return (req: Request, res: Response) => {
    const port = webPort()
    if (!port) {
      res.status(503).type('text/plain').send('The dev inbox isn\'t running, see the server log\n')
      return
    }

    const headers: IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` }
    // The admin login stays here: MailDev has none of its own
    delete headers.authorization
    delete headers.connection
    // Plain answers, so the page can be changed on the way
    delete headers['accept-encoding']

    const upstream = httpRequest({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.originalUrl,
      headers,
    }, (answer) => {
      res.removeHeader('Content-Security-Policy')
      res.removeHeader('X-Frame-Options')
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name) && !name.startsWith('access-control-'))
          res.setHeader(name, value)
      }
      res.setHeader('Content-Security-Policy', DEV_INBOX_CSP)
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      res.status(answer.statusCode ?? 502)

      // Only the UI's page: mail html comes from its API, and is shown as the mail is
      const isApi = req.originalUrl.slice(req.baseUrl.length).startsWith('/api/')
      const page = options.headScript && !isApi && String(answer.headers['content-type'] ?? '').includes('text/html') && !answer.headers['content-encoding']
      if (!page) {
        if (answer.headers['content-length'])
          res.setHeader('Content-Length', answer.headers['content-length'])
        answer.pipe(res)
        return
      }

      // MailDev's page: its own script first, in the head
      const chunks: Buffer[] = []
      answer.on('data', (chunk: Buffer) => chunks.push(chunk))
      answer.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
        res.send(html.replace(HEAD_RE, match => `${match}\n    <script src="${options.headScript}"></script>`))
      })
      answer.on('error', err => res.destroy(err))
    })
    upstream.on('error', (err) => {
      if (res.headersSent)
        res.destroy(err)
      else
        res.status(502).type('text/plain').send(`The dev inbox didn't answer: ${err.message}\n`)
    })
    req.pipe(upstream)
  }
}

/**
 * The inbox's live updates try a WebSocket first, which arrives as an upgrade, past Express and its login. Turn it
 * away, so they stay on Socket.IO's HTTP polling, which goes through the proxy and the login like the rest.
 */
export function refuseInboxUpgrades(server: NodeServer | undefined, basePath: string): void {
  server?.on('upgrade', (req: { url?: string }, socket: Duplex) => {
    if (req.url?.startsWith(`${basePath}/`))
      socket.destroy()
  })
}

/** The admin panel's Mail page: the inbox in a frame */
export function registerInboxPage(admin: AdminApi, inboxPath: string): void {
  admin.page({
    path: DEV_INBOX_PAGE,
    label: 'Mail',
    icon: 'mail',
    order: 30,
    render: () => ({
      title: 'Mail · dev inbox',
      html: `<iframe class="adm-frame" src="${inboxPath}/" title="Dev inbox"></iframe>`,
    }),
  })
}
