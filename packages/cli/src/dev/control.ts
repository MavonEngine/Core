import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type PluginInstaller from './installer'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { DEV_CONTROL_TOKEN_ENV, DEV_CONTROL_TOKEN_HEADER, DEV_CONTROL_URL_ENV } from '@mavonengine/core/Plugins/install'
import { InstallRefused } from './installer'

const MAX_BODY_BYTES = 8192

export interface DevControl {
  url: string
  token: string
  /** For the dev script, so the dev servers it starts can find and use this */
  env: Record<string, string>
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string')
    return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A small HTTP server through which the dev servers that `mavonengine dev` started ask it for things they
 * can't do themselves: installing packages and restarting them.
 *
 *   GET  /status                 { job }   the running or last install
 *   POST /install { packages }   { job }   start one; it restarts the dev script when it is done
 *
 * Only on localhost, on a port picked by the system, and only for whoever has the token: both are given
 * to the dev script in its environment and to nothing else.
 */
export function startDevControl(installer: PluginInstaller): Promise<DevControl> {
  const token = randomBytes(24).toString('hex')

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: object) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }

    if (!sameToken(req.headers[DEV_CONTROL_TOKEN_HEADER], token)) {
      reply(401, { error: 'Wrong or missing token' })
      return
    }

    if (req.method === 'GET' && req.url === '/status') {
      reply(200, { job: installer.job })
      return
    }

    if (req.method === 'POST' && req.url === '/install') {
      let packages: unknown
      try {
        ({ packages } = JSON.parse(await readBody(req)))
      }
      catch {
        reply(400, { error: 'Expected a JSON body' })
        return
      }

      try {
        reply(202, { job: installer.start(packages) })
      }
      catch (err) {
        if (!(err instanceof InstallRefused))
          throw err
        reply(err.reason === 'busy' ? 409 : 400, { error: err.message })
      }
      return
    }

    reply(404, { error: 'Not found' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve({
        url,
        token,
        env: { [DEV_CONTROL_URL_ENV]: url, [DEV_CONTROL_TOKEN_ENV]: token },
        close: () => new Promise((done) => {
          server.close(() => done())
          server.closeAllConnections()
        }),
      })
    })
  })
}
