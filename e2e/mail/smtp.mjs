/**
 * Just enough of an SMTP server for the end-to-end tests to receive what the mail plugin sends: no TLS, AUTH PLAIN,
 * any number of mails. Each mail is decoded from its MIME: headers, and the text and html parts.
 */
import { Buffer } from 'node:buffer'
import { createServer } from 'node:net'

const SOFT_BREAK_RE = /=\r?\n/g
const HEX_BYTE_RE = /^[0-9A-F]{2}$/i
const BLANK_LINE_RE = /\r?\n\r?\n/
const LEADING_BLANK_LINE_RE = /^\r?\n\r?\n/
const FOLDED_RE = /\r?\n[ \t]+/g
const LINE_RE = /\r?\n/
const WHITESPACE_RE = /\s+/g
const BOUNDARY_RE = /boundary="?([^";]+)"?/i
const LEADING_LINE_RE = /^\r?\n/
const DOUBLED_DOT_RE = /^\.\./gm

/** Undo quoted-printable: soft line breaks and =XX bytes, as UTF-8 */
function decodeQuotedPrintable(text) {
  const bytes = []
  const joined = text.replace(SOFT_BREAK_RE, '')
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && HEX_BYTE_RE.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    }
    else {
      bytes.push(...Buffer.from(joined[i], 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Headers (unfolded, by lowercase name) and body of one MIME entity */
function splitEntity(raw) {
  const end = raw.search(BLANK_LINE_RE)
  const head = end < 0 ? raw : raw.slice(0, end)
  const body = end < 0 ? '' : raw.slice(end).replace(LEADING_BLANK_LINE_RE, '')
  const headers = {}
  for (const line of head.replace(FOLDED_RE, ' ').split(LINE_RE)) {
    const colon = line.indexOf(':')
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { headers, body }
}

function decodeBody({ headers, body }) {
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (encoding === 'quoted-printable')
    return decodeQuotedPrintable(body)
  if (encoding === 'base64')
    return Buffer.from(body.replace(WHITESPACE_RE, ''), 'base64').toString('utf8')
  return body
}

/** The text and html of an entity, looking into multipart ones */
function parts(entity, found = {}) {
  const type = (entity.headers['content-type'] ?? 'text/plain').toLowerCase()
  const boundary = BOUNDARY_RE.exec(entity.headers['content-type'] ?? '')?.[1]
  if (type.startsWith('multipart/') && boundary) {
    for (const piece of entity.body.split(`--${boundary}`).slice(1)) {
      if (piece.startsWith('--'))
        break
      parts(splitEntity(piece.replace(LEADING_LINE_RE, '')), found)
    }
  }
  else if (type.startsWith('text/html')) {
    found.html ??= decodeBody(entity)
  }
  else if (type.startsWith('text/plain')) {
    found.text ??= decodeBody(entity)
  }
  return found
}

/** A received mail: envelope, headers and its text and html */
function decodeMail(envelope, data) {
  // SMTP doubles a dot at the start of a line
  const raw = data.replace(DOUBLED_DOT_RE, '.')
  const entity = splitEntity(raw)
  return { ...envelope, headers: entity.headers, subject: entity.headers.subject, ...parts(entity) }
}

/**
 * Listen on `port` (0 for any) and keep every mail in `received`. `close()` stops listening, so mail can't be
 * delivered, and `listen()` starts again on the same port.
 */
export async function fakeSmtp(port = 0) {
  const received = []
  const sockets = new Set()
  let server

  const handle = (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let envelope = { to: [] }
    let inData = false
    let buffer = ''
    const reply = line => socket.write(`${line}\r\n`)
    reply('220 e2e ESMTP')

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0)
            return
          received.push(decodeMail(envelope, buffer.slice(0, end)))
          buffer = buffer.slice(end + 5)
          inData = false
          envelope = { to: [], auth: envelope.auth }
          reply('250 queued')
          continue
        }

        const newline = buffer.indexOf('\r\n')
        if (newline < 0)
          return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        const command = line.slice(0, 4).toUpperCase()

        if (command === 'EHLO') {
          reply('250-e2e\r\n250-AUTH PLAIN\r\n250 8BITMIME')
        }
        else if (command === 'AUTH') {
          envelope.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8')
          reply('235 accepted')
        }
        else if (command === 'MAIL') {
          envelope.from = line.slice(line.indexOf('<') + 1, line.indexOf('>'))
          reply('250 ok')
        }
        else if (command === 'RCPT') {
          envelope.to.push(line.slice(line.indexOf('<') + 1, line.indexOf('>')))
          reply('250 ok')
        }
        else if (command === 'DATA') {
          inData = true
          reply('354 go on')
        }
        else if (command === 'QUIT') {
          reply('221 bye')
          socket.end()
        }
        else {
          reply('250 ok')
        }
      }
    })
    socket.on('error', () => {})
  }

  const listen = at => new Promise((resolve, reject) => {
    server = createServer(handle)
    server.once('error', reject)
    server.listen(at, '127.0.0.1', () => resolve(server.address().port))
  })
  const actualPort = await listen(port)

  return {
    port: actualPort,
    received,
    /** The mails to `address`, oldest first */
    to: address => received.filter(mail => mail.to.includes(address)),
    async close() {
      sockets.forEach(socket => socket.destroy())
      await new Promise(resolve => server.close(resolve))
    },
    listen: () => listen(actualPort),
  }
}
