import type { IncomingMessage } from 'node:http'

export const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether a request comes from this machine */
export function fromLocalhost(req: IncomingMessage): boolean {
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')
}

/**
 * Whether a request comes from a page of this dev server, or from no page at all (a tool on this machine).
 * A request another site makes from the browser says so in these headers.
 */
export function fromThisPage(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string')
    return site === 'same-origin'

  const { origin } = req.headers
  if (typeof origin !== 'string')
    return true

  try {
    return new URL(origin).host === req.headers.host
  }
  catch {
    return false
  }
}

/** The body of a request as text, rejecting one larger than `maxBytes` */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > maxBytes) {
        reject(new Error(`Body is larger than ${maxBytes} bytes`))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}
