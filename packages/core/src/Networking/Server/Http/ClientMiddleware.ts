import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Server as NodeServer } from 'node:http'
import type { ViteDevServer } from 'vite'
import type winston from 'winston'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import express from 'express'

export interface ClientOptions {
  /** Client project directory, where index.html and vite.config live */
  root: string

  /**
   * Serve the client source through Vite with hot reload instead of the built files.
   * Off by default so production never loads Vite, whatever NODE_ENV says.
   */
  dev?: boolean

  /** Built client served when `dev` is off. Default `<root>/dist` */
  dist?: string
}

/**
 * Serve the client source through a Vite dev server in middleware mode.
 * Hot reload shares the HTTP server's port. Requests that arrive while Vite is starting wait for it.
 */
export function devClientMiddleware(root: string, server: NodeServer, logger: winston.Logger): RequestHandler {
  const vite: Promise<ViteDevServer> = import('vite').then(({ createServer }) => createServer({
    root: resolve(root),
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server } },
  }))

  vite.then(
    (dev) => {
      logger.info(`Serving the client from ${root} through Vite`)
      server.on('close', () => void dev.close())
    },
    err => logger.error(`Could not start Vite for the client: ${(err as Error).message}`),
  )

  return (req: Request, res: Response, next: NextFunction) => {
    vite.then(dev => dev.middlewares(req, res, next), next)
  }
}

/**
 * Serve a built client, falling back to index.html for page routes so client-side routing works.
 * Paths with a file extension are files, so a missing one stays a 404 instead of turning into the page.
 * Returns undefined when there is nothing built at `dist`.
 */
export function staticClientMiddleware(dist: string): RequestHandler | undefined {
  const index = join(dist, 'index.html')
  if (!existsSync(index))
    return undefined

  const router = express.Router()
  router.use(express.static(dist, { index: false }))
  router.use((req, res, next) => {
    const isPage = (req.method === 'GET' || req.method === 'HEAD')
      && !req.path.startsWith('/api/')
      && !extname(req.path)
      && req.accepts('html')
    if (!isPage) {
      next()
      return
    }

    res.sendFile(resolve(index))
  })

  return router
}
