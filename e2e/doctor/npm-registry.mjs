/**
 * A small npm registry for the doctor e2e test: answers `GET /<package>` with the package's full document, the way
 * registry.npmjs.org does, and 404s every package it doesn't have. `mavonengine doctor` reaches it through
 * npm_config_registry, so the test doesn't depend on what is published on npm right now.
 */
import { createServer } from 'node:http'

/**
 * Start the registry on a free port. `packages` maps a name to `{ latest, versions: { [version]: packageJson } }`.
 * `requests` lists the packages asked for, in order.
 */
export async function startRegistry(packages) {
  const requests = []

  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://registry').pathname.slice(1))
    requests.push(name)

    const pkg = packages[name]
    res.setHeader('content-type', 'application/json')
    if (req.method !== 'GET' || !pkg) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    const versions = Object.fromEntries(Object.entries(pkg.versions).map(([version, json]) => [version, { name, version, ...json }]))
    res.end(JSON.stringify({ 'name': name, 'dist-tags': { latest: pkg.latest }, versions }))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** A port nothing listens on: one the system handed out and that was closed again */
export async function closedPort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}
