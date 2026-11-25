import type { Transport, TransportConfig } from 'nodemailer'
import type { MailMessage } from './message'
import { createTransport } from 'nodemailer'
import { formatAddress } from './message'

/** What a transport said when it took a mail */
export interface SentMail {
  /** The id the transport gave the mail, when it gives one */
  messageId?: string
}

/**
 * Delivers mail: SMTP, a provider's HTTP API, the log. Give one to the mail plugin with `useTransport()`.
 * `send()` rejects when the mail couldn't be handed over; a queued mail is then tried again.
 */
export interface MailTransport {
  /** Shown in the log, e.g. `smtp` or `mailgun` */
  readonly name: string
  send(message: MailMessage): Promise<SentMail | void>
  /** Called when the server stops, or the transport is replaced */
  close?(): void | Promise<void>
}

/** Anything nodemailer's `createTransport()` takes: an SMTP URL, SMTP options, `{ SES: … }`, a transport plugin */
export type NodemailerTransport = TransportConfig | Transport<any, any> | string

/**
 * A transport on nodemailer (https://nodemailer.com): SMTP, SES, sendmail, or one of its community transports such
 * as `nodemailer-mailgun-transport`.
 */
export function nodemailerTransport(config: NodemailerTransport, name?: string): MailTransport {
  const mailer = createTransport(config as TransportConfig)
  return {
    name: name ?? (mailer.transporter as { name?: string } | undefined)?.name?.toLowerCase() ?? 'nodemailer',
    async send(message) {
      const info = await mailer.sendMail({
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
      })
      const messageId = (info as { messageId?: unknown } | undefined)?.messageId
      return typeof messageId === 'string'
        ? { messageId }
        : {}
    },
    close: () => mailer.close(),
  }
}

/** How much of a mail's body the log transport writes */
export const LOG_BODY_CHARS = 2000

const COMMENTS_RE = /<!--[\s\S]*?-->/g
const HEAD_RE = /<head[\s>][\s\S]*?<\/head>/gi
const BLOCK_END_RE = /<\/(?:p|div|tr|h[1-6]|li)>|<br\s*\/?>/gi
const TAGS_RE = /<[^>]*>/g
const SPACES_RE = /[ \t]+/g
const BLANK_LINES_RE = /\n\s*\n\s*/g

/** The words of an html mail, roughly, for the log: no head, comments or tags, a line per paragraph */
export function htmlToLogText(html: string): string {
  return html
    .replace(COMMENTS_RE, '')
    .replace(HEAD_RE, '')
    .replace(BLOCK_END_RE, '\n')
    .replace(TAGS_RE, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&copy;/g, '©')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map(line => line.replace(SPACES_RE, ' ').trim())
    .join('\n')
    .replace(BLANK_LINES_RE, '\n')
    .trim()
}

interface Logger {
  info(message: string): unknown
}

/**
 * Writes mail to the log instead of sending it: the mail plugin's transport until one is set up, so a game in
 * development can send mail without an account anywhere.
 */
export function logTransport(logger: Logger | null | undefined): MailTransport {
  return {
    name: 'log',
    async send(message) {
      const body = message.text ?? htmlToLogText(message.html!)
      const cut = body.length > LOG_BODY_CHARS
        ? `${body.slice(0, LOG_BODY_CHARS)}…`
        : body
      logger?.info([
        `Mail (not sent: no mail transport is set up) to ${message.to.map(formatAddress).join(', ')}: ${message.subject}`,
        cut,
      ].join('\n'))
    },
  }
}

/** Keeps mail in `sent` instead of sending it, for tests: `mail.useTransport(memory)` */
export function memoryTransport(): MailTransport & { sent: MailMessage[] } {
  const sent: MailMessage[] = []
  return {
    name: 'memory',
    sent,
    async send(message) {
      sent.push(message)
      return { messageId: `memory-${sent.length}` }
    },
  }
}
