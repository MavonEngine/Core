import { escapeHtml } from './pages'
import { RESET_PASSWORD_MINUTES, VERIFY_EMAIL_HOURS } from './protocol'

/** A mail as the mail plugin takes it. By shape, so this plugin works without the mail plugin installed */
export interface MailInput {
  to: string
  subject: string
  text: string
  html: string
  preheader?: string
}

/** What this plugin uses of the mail plugin, `ctx.plugin('@mavonengine/mail')` */
export interface MailLike {
  send(mail: MailInput): Promise<unknown>
}

const BUTTON_STYLE = 'display: inline-block; padding: 12px 22px; background-color: #3b5bdb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;'

function button(url: string, label: string): string {
  return `<p style="margin: 24px 0;"><a href="${escapeHtml(url)}" style="${BUTTON_STYLE}">${escapeHtml(label)}</a></p>`
}

function paragraph(text: string): string {
  return `<p style="margin: 0 0 16px;">${escapeHtml(text)}</p>`
}

/** The link as text too, for mail clients that hide the button */
function fallback(url: string): string {
  return `<p style="margin: 0 0 16px; font-size: 13px; color: #6b7080;">Or open this link: <a href="${escapeHtml(url)}" style="color: #3b5bdb; word-break: break-all;">${escapeHtml(url)}</a></p>`
}

export function verifyEmailMail(to: string, name: string, url: string, appName?: string): MailInput {
  const game = appName
    ? ` for ${appName}`
    : ''
  const hello = `Hi ${name},`
  const ask = `Please confirm that ${to} is your email address${game}.`
  const expiry = `The link works for ${VERIFY_EMAIL_HOURS} hours. If you didn't make this account, you can ignore this mail.`
  return {
    to,
    subject: 'Confirm your email address',
    preheader: ask,
    text: `${hello}\n\n${ask}\n\n${url}\n\n${expiry}`,
    html: paragraph(hello) + paragraph(ask) + button(url, 'Confirm my email') + fallback(url) + paragraph(expiry),
  }
}

export function resetPasswordMail(to: string, name: string, url: string, appName?: string): MailInput {
  const game = appName
    ? ` on ${appName}`
    : ''
  const hello = `Hi ${name},`
  const ask = `Someone asked to reset the password of your account ${name}${game}. Choose a new one with this link.`
  const expiry = `The link works for ${RESET_PASSWORD_MINUTES} minutes, once. If it wasn't you, ignore this mail: your password stays as it is.`
  return {
    to,
    subject: 'Reset your password',
    preheader: 'Choose a new password',
    text: `${hello}\n\n${ask}\n\n${url}\n\n${expiry}`,
    html: paragraph(hello) + paragraph(ask) + button(url, 'Choose a new password') + fallback(url) + paragraph(expiry),
  }
}
