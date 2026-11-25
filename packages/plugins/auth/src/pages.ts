import type { Response } from 'express'

/**
 * The pages the links in the plugin's mails open, for games without pages of their own (see `verifyUrl` and
 * `resetUrl`). Plain HTML without scripts or anything from elsewhere, so they work on any game server.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}
const HTML_SPECIAL_RE = /[&<>"']/g

export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIAL_RE, char => HTML_ESCAPES[char])
}

const STYLE = `
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f2f3f5; color: #2b2e35; }
  main { max-width: 420px; margin: 12vh auto; padding: 32px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { margin: 0 0 16px; font-size: 22px; }
  p { line-height: 1.5; }
  label { display: block; margin: 16px 0 6px; font-weight: 600; }
  input { box-sizing: border-box; width: 100%; padding: 10px 12px; font: inherit; border: 1px solid #c9ccd3; border-radius: 6px; }
  button { margin-top: 20px; width: 100%; padding: 12px; font: inherit; font-weight: 600; color: #fff; background: #3b5bdb; border: 0; border-radius: 6px; cursor: pointer; }
  .error { color: #c92a2a; }
  @media (prefers-color-scheme: dark) {
    body { background: #16171b; color: #e4e6eb; }
    main { background: #212328; box-shadow: none; }
    input { background: #16171b; color: inherit; border-color: #3a3d45; }
    .error { color: #ff8787; }
  }
`

/** Send a page: no scripts, nothing from elsewhere, not framed, and the token in its URL never sent on as a referrer */
export function sendPage(res: Response, status: number, title: string, body: string) {
  res.status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'; frame-ancestors \'none\'; base-uri \'none\'',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    })
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`)
}

/** A paragraph of text, escaped */
export function text(message: string, className?: string): string {
  return `<p${className
    ? ` class="${className}"`
    : ''}>${escapeHtml(message)}</p>`
}

/**
 * The page a confirmation link opens. It asks before confirming: mail scanners open links in mails, and a page that
 * confirmed on opening would let them
 */
export function verifyEmailPage(action: string, token: string, email: string): string {
  return `${text(`Confirm that ${email} is your email address.`)}
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Confirm my email</button>
</form>`
}

export function resetPasswordPage(action: string, token: string, minLength: number, error?: string): string {
  return `${error
    ? text(error, 'error')
    : ''}${text('Choose a new password. You will be logged out everywhere else.')}
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="${minLength}" required autofocus>
<label for="confirm">Once more</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${minLength}" required>
<button type="submit">Set the password</button>
</form>`
}
