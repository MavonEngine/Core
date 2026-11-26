# @mavonengine/mail

A [MavonEngine](https://mavonengine.com) plugin that sends mail from the game server: welcome mails, password resets, receipts. Mail goes on the server's queue and is tried again when the mail server is down, so a slow or failing provider never holds up the game.

```sh
npx @mavonengine/cli install @mavonengine/mail
```

Until you set up a transport, mail is written to the server's log instead of sent, so you can build and test mail in development without an account anywhere.

## Sending mail

Write a mail as a class, then send it to someone:

```ts
import { escapeHtml, Mailable } from '@mavonengine/mail'

export class Welcome extends Mailable {
  constructor(private name: string) {
    super()
  }

  subject() {
    return `Welcome, ${this.name}!`
  }

  text() {
    return `Good to have you, ${this.name}.`
  }

  html() {
    // Escape what players wrote before it goes into html
    return `<p>Good to have you, <b>${escapeHtml(this.name)}</b>.</p>`
  }
}
```

In a plugin, the mail plugin is `ctx.plugin('@mavonengine/mail')`. It is undefined when the project doesn't have the mail plugin, so a plugin can make mail optional:

```ts
export default {
  http(app, ctx) {
    app.post('/api/shop/buy', async (req, res) => {
      const order = await buy(req.body)
      await ctx.plugin('@mavonengine/mail')?.to(order.email).send(new Receipt(order))
      res.json(order)
    })
  },
} satisfies ServerPlugin
```

In the game's server code, use `mail(server)`:

```ts
import { mail } from '@mavonengine/mail'

await mail(server)?.to('Ada <ada@example.com>').cc('team@example.com').send(new Welcome('Ada'))
```

- **Queued by default.** `send()` returns once the mail is on the queue, as `{ queued: true, jobId }`. The queue sends it in the background, tries it 3 times with a pause of 10 seconds and then a minute, and keeps it among the queue's failed jobs when every try failed. With a database plugin such as [`@mavonengine/sqlite`](../sqlite), queued mail survives a restart.
- **Right away:** `sendNow()` sends in the call and rejects when the transport does. A mailable with `queued = false`, or `send(mailable, { queued: false })`, does the same. `send(mailable, { delayMs })` sends it later.
- **Checked when you send.** A mail without a recipient, subject or text and html, with an address that is none, or with a line break in its subject, a name or a header, throws a `MailError` from `send()`. You find out right away instead of in the log when the queue gets to it.
- **Rendered when you send.** What waits on the queue is the finished mail, plain JSON, not the class.
- **A mail written out**, e.g. one a notification built: `mail.send({ to, subject, text, html })`.

`from`, `replyTo` and `headers()` can be set per mailable. Mail without a `from` gets the one from the options.

## Layout

HTML mail is sent in a layout: the game's name at the top, the mail on a white card, a footer below. A mail with only text gets html made from it too, a paragraph per blank line, so every mail looks the same. Write `html()` as what goes inside the layout, not as a whole page.

To change the layout, publish it into your project:

```sh
npx @mavonengine/cli asset:publish @mavonengine/mail
```

That copies it to `resources/@mavonengine/mail/layout.html`, which is used from then on. Outside production the file is read again for every mail, so a change shows in the next one without restarting.

In the layout, `{{ name }}` is filled in escaped and `{{{ name }}}` as it is:

| | |
| --- | --- |
| `{{{ content }}}` | The mail's html, or its text made into paragraphs |
| `{{ subject }}` | The subject |
| `{{ preheader }}` | The line inboxes show next to the subject, from a mailable's `preheader()` or `preheader` in `send()` |
| `{{ appName }}` | The game's name, `appName` in `mavonengine.json`, else the sender's name |
| `{{ appUrl }}` | Where the game is: `appUrl` in `mavonengine.json` (or `MAVONENGINE_APP_URL`), for a link back to it. Empty when it isn't set |
| `{{ year }}` | This year |
| anything else | From `layoutData` in the options, e.g. `{{ footer }}` |

Comments are left out of the mail, apart from Outlook's conditional comments (`<!--[if mso]>`). Mail clients ignore most CSS and `<style>` blocks: keep to tables and inline styles, as the default layout does.

A mailable with `layout = false`, or `send({ …, layout: false })`, is sent without it; the `layout` option turns it off for all mail. When a layout can't be read, mail is sent without it and the log says so.

`escapeHtml()` makes what players wrote safe to put in a mail's html:

```ts
import { escapeHtml, Mailable } from '@mavonengine/mail'

class Welcome extends Mailable {
  constructor(private name: string) {
    super()
  }

  subject() {
    return 'Welcome!'
  }

  preheader() {
    return 'Your account is ready'
  }

  html() {
    return `<p>Good to have you, <b>${escapeHtml(this.name)}</b>.</p>`
  }
}
```

## Transports

Mail goes through one transport at a time.

### SMTP

Almost every provider has an SMTP relay: Mailgun, Amazon SES, Postmark, SendGrid, Resend, your own server. Put the server in the options and the password in the environment:

```json
{
  "plugins": {
    "@mavonengine/mail": {
      "options": {
        "from": "My Game <noreply@mygame.com>",
        "smtp": { "host": "smtp.mailgun.org", "port": 587, "user": "postmaster@mg.mygame.com" }
      }
    }
  }
}
```

```sh
MAVONENGINE_MAIL_SMTP_PASSWORD=… npm start
```

Or put everything in one URL: `MAVONENGINE_MAIL_SMTP_URL=smtps://user:password@smtp.example.com`. Port 465 connects with TLS. Other ports upgrade with STARTTLS when the server offers it.

### Anything nodemailer sends through

Mail is sent with [nodemailer](https://nodemailer.com), so its transports work too. Those are objects, not JSON, so set them up in code:

```ts
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { mail } from '@mavonengine/mail'

mail(server)?.useNodemailer({
  SES: {
    sesClient: new SESv2Client({ region: 'eu-west-1' }),
    SendEmailCommand
  }
}, 'ses')
```

Community transports such as `nodemailer-mailgun-transport` work the same way.

### Your own

A transport is an object with a `name` and a `send()` that resolves once the mail was handed over. That is all a provider's plugin needs:

```ts
import type { MailTransport } from '@mavonengine/mail'
import { formatAddress } from '@mavonengine/mail'

const postmark: MailTransport = {
  name: 'postmark',
  async send(message) {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'X-Postmark-Server-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        From: formatAddress(message.from!),
        To: message.to.map(formatAddress).join(', '),
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html
      }),
    })
    if (!res.ok)
      throw new Error(`Postmark answered ${res.status}`)
    return { messageId: (await res.json()).MessageID }
  },
}

ctx.plugin('@mavonengine/mail')?.useTransport(postmark)
```

`send()` should reject when the mail wasn't taken, so the queue tries it again. `close()`, when it has one, is called when the transport is replaced and when the server stops.

### In tests

`memoryTransport()` keeps mail in its `sent` array instead of sending it:

```ts
import { memoryTransport } from '@mavonengine/mail'

const memory = memoryTransport()
mail(server)!.useTransport(memory)
// …
expect(memory.sent[0].subject).toBe('Welcome, Ada!')
```

## Dev inbox

In development, mail the game sends can go to a [MailDev](https://maildev.github.io/maildev/) inbox in the game server's admin panel instead of only to the log. Install MailDev as a dev dependency:

```sh
npm i -D maildev
```

Then open `http://localhost:8050/admin/mail/`. Every mail the game sends shows up there as it arrives, with its html, text, headers and source. Nothing leaves your machine, and the mail needs no sender. The mail is kept in `.mavonengine/maildev`, so it is still there after the dev server restarts.

How it works:
- MailDev runs inside the game server, its SMTP and web servers on free ports of this machine only.
- Its UI is proxied from `/admin/mail/inbox/` behind the admin panel's login, and it starts dark, like the panel.
- Its live updates use HTTP polling rather than a WebSocket, which would get past the login.

It is used only while no SMTP server or transport is set up, and only in development: never with `NODE_ENV=production` or in tests. Without `maildev` installed, mail is written to the log as before. Turn it off with `"devInbox": false`.

### With an AI assistant

While the game runs under `mavonengine dev`, [`mavonengine mcp`](https://github.com/MavonEngine/Core/tree/main/packages/cli#mavonengine-mcp) gives your assistant the dev inbox. It can then follow a flow that sends mail to the end on its own, e.g. "sign up a test account and verify its address":

| Tool | |
| --- | --- |
| `mail_inbox` | The mail in the dev inbox, newest first: sender, recipients, subject and the start of the text. Filter by recipient, subject, words or unread |
| `mail_read` | One mail, by id or the newest to an address or with a subject: its text and every link in it, like the one to verify an address or reset a password. Can wait for mail the game queued a moment ago |
| `mail_clear` | Delete one mail from the inbox, or all of them |

The first two only read; reading a mail marks it read in the inbox. Your assistant's MCP client asks you before it deletes mail, and `mavonengine mcp --read-only` leaves `mail_clear` out. Only the dev inbox is ever touched: these tools send no mail.

The tools come from the plugin's dev entry, which runs in the client's Vite dev server. The game server writes where MailDev listens to `.mavonengine/plugins/@mavonengine/mail/inbox.json` when it starts it and removes the file when it stops. Without a running dev inbox, the tools say why there may be none.

## Options

Set them under the plugin in `mavonengine.json`. All are optional.

| Option | Default | |
| --- | --- | --- |
| `from` | | The sender of mail that names none, like `My Game <noreply@mygame.com>`. `MAVONENGINE_MAIL_FROM` overrides it. Needed for every transport except the log |
| `smtp` | | The SMTP server: `{ host, port, secure, user }`, or a URL without the password. See [SMTP](#smtp) |
| `queued` | `true` | Queue mail, or send it in the call. A mailable's `queued` and `send()`'s options win over it |
| `queue` | `default` | The queue mail goes on. Use a queue of its own to keep mail from waiting behind other jobs, with the server's `queue.queues` |
| `tries` | `3` | How often a queued mail is tried before it counts as failed |
| `backoffMs` | `[10000, 60000]` | How long to wait before trying again, in ms: one number, or one per retry, the last repeating |
| `layout` | `true` | Send mail in the [layout](#layout) |
| `layoutData` | `{}` | More values for the layout, e.g. `{ "footer": "You get this because you play My Game." }` |
| `devInbox` | `true` | In development, send mail to the [dev inbox](#dev-inbox) while no transport is set up |

| Environment | |
| --- | --- |
| `MAVONENGINE_MAIL_FROM` | Overrides `from` |
| `MAVONENGINE_MAIL_SMTP_URL` | The SMTP server with its credentials, overriding `smtp` |
| `MAVONENGINE_MAIL_SMTP_PASSWORD` | The password for `smtp`. Keep it out of mavonengine.json |

## Not yet

Attachments and a view of sent mail in the dashboard. Failed mail shows among the queue's failed jobs, as `mail:send`.
