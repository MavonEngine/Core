/**
 * End-to-end test for `mavonengine mcp`, run against packages/multiplayer-template in dev mode:
 *
 * 1. boots the game server, which serves the client through Vite with the dev bridge
 * 2. a player joins in Chrome
 * 3. an MCP client starts `mavonengine mcp` over stdio, like an AI assistant would, and reads the server
 *    and the player's tab: scene on both sides, renderer stats, the client's world, network, console
 *    output, a screenshot, and the player compared on server and client
 * 4. a second tab opens the editor: both tabs are listed, and `auto` still picks the player's tab
 *
 * Needs Chrome, core and the CLI built and the template's dependencies installed.
 *
 *   node e2e/mcp/run.mjs
 */
import { Buffer } from 'node:buffer'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright-core'
import { base, check, cli, log, PORT, run, startServer, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = join(here, 'screenshots')

async function waitFor(page, fn, arg, timeout = 30000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 200 })
}

async function joinGame(page, name) {
  await page.goto(base)
  await page.locator('.name-input').fill(name)
  await page.locator('.join-btn').click()
  await waitFor(page, () => window.Game?.activeScene?.name === 'main' && !!window.Game.network?.connected)
}

async function main() {
  let server
  let browser
  let mcp
  const errors = []

  rmSync(screenshots, { recursive: true, force: true })
  mkdirSync(screenshots, { recursive: true })

  try {
    log('\n== server')
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1' })

    log('\n== player')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const player = await context.newPage()
    player.on('pageerror', error => errors.push(`player: ${error.message}`))
    await joinGame(player, 'Alice')

    log('\n== mcp')
    mcp = new Client({ name: 'e2e', version: '0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--port', String(PORT)], stderr: 'ignore' }))

    const call = async (name, args = {}) => {
      const result = await mcp.callTool({ name, arguments: args })
      if (result.isError)
        throw new Error(`${name} failed: ${result.content[0].text}`)
      return result
    }
    const data = async (name, args) => JSON.parse((await call(name, args)).content[0].text)

    const { tools } = await mcp.listTools()
    check(tools.length === 17 && tools.every(tool => tool.annotations?.readOnlyHint), 'it lists 17 read-only tools')

    const serverPlayers = await data('list_players')
    check(serverPlayers.length === 1 && serverPlayers[0].displayName === 'Alice', 'list_players shows Alice on the server')
    const playerId = serverPlayers[0].id

    const { clients } = await data('list_clients')
    check(clients.length === 1 && clients[0].playerId === playerId && !clients[0].editor, 'list_clients finds the tab, with the player id the server uses')

    const status = await data('client_status')
    check(status.frame?.calls > 0 && status.frame.triangles > 0, `client_status counts a whole frame (${status.frame?.calls} draw calls, ${status.frame?.triangles} triangles)`)
    check(status.gpuMemory.geometries > 0 && status.canvas.width > 0 && status.scene === 'main', 'and reports GPU memory, the canvas and the scene')

    const serverScene = await data('get_scene')
    const clientScene = await data('client_scene')
    const built = scene => Object.fromEntries(scene.objects.map(o => [o.id, o.built]))
    check(built(serverScene).forest === true && built(clientScene).forest === false, 'the server builds the tree field, the client does not')
    check(built(clientScene).sun === true && built(serverScene).sun === false, 'the client builds the lights, the server does not')

    const entities = await data('client_entities', { type: 'Player' })
    check(entities.entities.some(e => e.localPlayer), 'client_entities marks the local player')

    const network = await data('client_network')
    check(network.network.connected && network.network.playerId === playerId, 'client_network shows the connection')

    // Move the player so prediction and the server have something to agree on
    await player.locator('canvas').click({ position: { x: 600, y: 400 }, force: true })
    await player.keyboard.down('KeyW')
    await delay(800)
    await player.keyboard.up('KeyW')
    await delay(800)

    const compared = await data('compare_entity', { id: playerId })
    check(compared.server && compared.client && compared.clientId === 'localPlayer', 'compare_entity finds the player on both sides, as localPlayer on the client')
    check(compared.positionDelta.length < 1, `the client's player is where the server has it (${compared.positionDelta.length.toFixed(3)} apart)`)
    check(Math.abs(compared.server.position.z) + Math.abs(compared.server.position.x) > 0.1, 'after it moved')

    await player.evaluate(() => console.error('e2e marker', { id: 1 }))
    const errorLogs = await data('client_logs', { level: 'error', contains: 'e2e marker' })
    check(errorLogs.entries.length === 1 && errorLogs.entries[0].message === 'e2e marker {"id":1}', 'client_logs has the console error')
    const allLogs = await data('client_logs', { contains: 'Socket connection established' })
    check(allLogs.matched === 1, 'and the engine logger output from the start of the page')

    const shot = await call('client_screenshot', { maxWidth: 600 })
    const image = Buffer.from(shot.content[0].data, 'base64')
    writeFileSync(join(screenshots, 'client.jpg'), image)
    check(shot.content[0].type === 'image' && image[0] === 0xFF && image[1] === 0xD8 && image.length > 5000, `client_screenshot returns a JPEG (${image.length} bytes, ${shot.content[1].text})`)

    log('\n== editor')
    const editor = await context.newPage()
    editor.on('pageerror', error => errors.push(`editor: ${error.message}`))
    await editor.goto(base)
    await waitFor(editor, () => window.Game?.activeScene?.name === 'main')
    await editor.locator('canvas').click({ position: { x: 600, y: 400 }, force: true })
    await editor.keyboard.press('Period')
    await waitFor(editor, () => !!window.Game.editor)

    let both
    for (let tries = 0; tries < 20; tries++) {
      both = await data('list_clients')
      if (both.clients.length === 2 && both.clients.some(c => c.editor))
        break
      await delay(500)
    }
    check(both.clients.length === 2 && both.clients.filter(c => c.editor).length === 1, 'list_clients shows the player and the editor tab')
    const auto = await data('client_network')
    check(auto.network.playerId === playerId, 'without a client id the tools still ask the player\'s tab')
    const editorId = both.clients.find(c => c.editor).id
    check((await data('client_network', { clientId: editorId })).network.editorMode === true, 'and the editor tab by its id')

    await editor.close()
    let left
    for (let tries = 0; tries < 20; tries++) {
      left = (await data('list_clients')).clients
      if (left.length === 1)
        break
      await delay(250)
    }
    check(left.length === 1 && left[0].playerId === playerId, 'a closed tab leaves the list')

    check(errors.length === 0, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`)
    log('\nmcp end-to-end test passed')
  }
  finally {
    await mcp?.close().catch(() => {})
    await browser?.close()
    await server?.stop()
  }
}

main().catch((err) => {
  log(`\nmcp end-to-end test failed: ${err.message}`)
  process.exit(1)
})
