/**
 * End-to-end test for `mavonengine mcp`, run against packages/multiplayer-template in dev mode:
 *
 * 1. boots the game server, which serves the client through Vite with the dev bridge
 * 2. a player joins in Chrome
 * 3. an MCP client starts `mavonengine mcp` over stdio, like an AI assistant would, and reads the server
 *    and the player's tab: scene on both sides, renderer stats, the client's world, network, console
 *    output, a screenshot, the player compared on server and client, and the packets and state sync of both sides
 * 4. a second tab opens the editor: both tabs are listed, and `auto` still picks the player's tab.
 *    Its Network panel lists the server's packets, and the overlay draws the player's ghost and sync ring
 *
 * Needs Chrome, core and the CLI built and the template's dependencies installed. The docs tools and the tools for
 * the plugins that can be installed are left out (--no-docs, --no-plugin-list): they read mavonengine.com and
 * GitHub, which CI shouldn't depend on.
 *
 *   node e2e/mcp/run.mjs
 */
import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * What went wrong on a page besides thrown errors: console errors, requests that failed or were refused.
 * A module of the editor that doesn't load shows up here and nowhere else
 */
function watchPage(page, name, problems) {
  page.on('console', (message) => {
    if (message.type() === 'error')
      problems.push(`${name} console: ${message.text()}`)
  })
  page.on('requestfailed', request => problems.push(`${name} request failed: ${request.url()} (${request.failure()?.errorText})`))
  page.on('response', (response) => {
    if (response.status() >= 400)
      problems.push(`${name} ${response.status()}: ${response.url()}`)
  })
}

/** How long the editor's UI may take to load: it is built from source by the dev server, next to a game that renders in software */
const EDITOR_UI_TIMEOUT = 120000

/**
 * The editor exists as soon as `.` is pressed, its UI only once the dev server has built it and React has drawn it.
 * Fails with what the page reported when that doesn't happen, instead of a bare timeout
 */
async function waitForEditorUi(page, errors, problems) {
  const started = Date.now()
  const tab = page.getByRole('tab', { name: 'Network' })

  while (true) {
    if (await tab.count() > 0)
      break
    if (errors.length)
      throw new Error(`the editor's UI did not load:\n  ${errors.join('\n  ')}`)
    if (Date.now() - started > EDITOR_UI_TIMEOUT)
      throw new Error(`the editor's UI was not there after ${EDITOR_UI_TIMEOUT / 1000}s${problems.length ? `:\n  ${problems.slice(-20).join('\n  ')}` : ', and the page reported nothing'}`)
    await delay(500)
  }

  log(`  the editor's UI took ${((Date.now() - started) / 1000).toFixed(1)}s to load`)
  return tab
}

/** Everything that helps to tell why a run failed, since CI can't be looked at afterwards */
async function reportFailure(context, server, errors, problems) {
  log('\n== failure details')
  if (errors.length)
    log(`page errors:\n  ${errors.join('\n  ')}`)
  if (problems.length)
    log(`page problems (last 30):\n  ${problems.slice(-30).join('\n  ')}`)

  for (const [index, page] of (context?.pages() ?? []).entries()) {
    try {
      const state = await page.evaluate(() => ({
        title: document.title,
        editor: !!window.Game?.editor,
        uiChildren: window.Game?.uiRoot?.childElementCount ?? null,
        tabs: Array.from(document.querySelectorAll('[role=tab]'), tab => tab.textContent),
        text: document.body.textContent.replace(/\s+/g, ' ').slice(0, 300),
      }))
      log(`page ${index}: ${JSON.stringify(state)}`)
      await page.screenshot({ path: join(screenshots, `failure-page-${index}.png`), timeout: 15000 })
    }
    catch (err) {
      log(`page ${index}: could not be looked at: ${err.message.split('\n')[0]}`)
    }
  }

  if (server)
    log(`server output (last 40 lines):\n${server.output().split('\n').slice(-40).join('\n')}`)
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
  let context
  const errors = []
  const problems = []

  rmSync(screenshots, { recursive: true, force: true })
  mkdirSync(screenshots, { recursive: true })

  try {
    log('\n== server')
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1' })

    log('\n== player')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const player = await context.newPage()
    player.on('pageerror', error => errors.push(`player: ${error.message}`))
    watchPage(player, 'player', problems)
    await joinGame(player, 'Alice')

    log('\n== mcp')
    mcp = new Client({ name: 'e2e', version: '0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--port', String(PORT), '--no-docs', '--no-plugin-list'], stderr: 'ignore' }))

    const call = async (name, args = {}) => {
      const result = await mcp.callTool({ name, arguments: args })
      if (result.isError)
        throw new Error(`${name} failed: ${result.content[0].text}`)
      return result
    }
    const data = async (name, args) => JSON.parse((await call(name, args)).content[0].text)

    const { tools } = await mcp.listTools()
    check(tools.length === 25 && tools.every(tool => tool.annotations?.readOnlyHint), 'it lists 25 read-only tools')

    // The name follows the connection in a message of its own, so the server may know the player before its name
    let serverPlayers
    for (let tries = 0; tries < 40; tries++) {
      serverPlayers = await data('list_players')
      if (serverPlayers.length === 1 && serverPlayers[0].displayName === 'Alice')
        break
      await delay(250)
    }
    check(serverPlayers.length === 1 && serverPlayers[0].displayName === 'Alice', `list_players shows Alice on the server (got ${JSON.stringify(serverPlayers.map(player => player.displayName))})`)
    const playerId = serverPlayers[0].id

    // The template has no plugins, and CI doesn't read the list of those it could add (--no-plugin-list)
    check((await data('list_plugins')).plugins.length === 0, 'list_plugins asks the server for the project\'s plugins')

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

    log('\n== network')
    const sent = await data('network_packets', { peer: playerId, type: 'sv_state', direction: 'out', limit: 5 })
    const ticks = sent.records.map(record => record.tick)
    check(sent.records.length === 5 && ticks.every((tick, i) => i === 0 || tick === ticks[i - 1] + 1), `network_packets lists the states sent to the player, one per tick (${ticks.join(', ')})`)
    check(sent.records.every(record => record.bytes > 0 && record.info.entities >= 1), 'with their size and entity count')

    const packet = await data('network_packet', { id: sent.records.at(-1).id })
    check(packet.payload.tick === ticks.at(-1) && packet.payload.entities.some(e => e.id === playerId) && typeof packet.payload.ack === 'number', 'network_packet shows the payload: tick, ack and the player')

    const moves = await data('network_packets', { peer: playerId, type: 'command', direction: 'in' })
    check(moves.records.length > 0 && moves.records.every(record => typeof record.sequenceId === 'number'), `and the server recorded the player's inputs (${moves.records.length})`)
    check(packet.payload.ack === moves.records.at(-1).sequenceId, `the last state acknowledges the last input (${packet.payload.ack})`)

    const received = await data('client_packets', { type: 'sv_state', limit: 5 })
    check(received.records.length === 5 && received.records.every(record => record.direction === 'in' && record.tick > 0), 'client_packets lists the states the tab received')
    const joined = await data('client_packets', { type: 'cl_init' })
    check(joined.records.length === 1 && joined.records[0].reliable === true, 'and the game\'s own reliable message, once')
    const lastState = (await data('client_network')).network.lastState
    check(lastState.tick > 0 && lastState.ack === packet.payload.ack && lastState.ageMs < 1000, `client_network tells the last state: tick ${lastState.tick}, ack ${lastState.ack}, ${lastState.ageMs}ms ago`)

    const sync = await data('network_sync')
    check(sync.syncDistance === 200 && sync.players.length === 1 && sync.players[0].tracked.includes(playerId), 'network_sync shows what the player is sent')
    check(sync.players[0].lastState.tick <= sync.tick && sync.entities.find(e => e.id === playerId).trackedBy === 1, 'and by how many players each entity is tracked')

    // The newest arrival and the newest handled input: their other halves are older, so well inside the window
    const timeline = await data('network_timeline', { sinceMs: 10000, limit: 2000 })
    const arrived = timeline.entries.findLast(e => e.side === 'client' && e.type === 'sv_state')
    const left = timeline.entries.find(e => e.side === 'server' && e.type === 'sv_state' && e.tick === arrived?.tick)
    // Two clocks a millisecond apart can swap the two on localhost, so the order is not checked
    const travelMs = arrived && left ? new Date(arrived.time) - new Date(left.time) : Number.NaN
    check(Math.abs(travelMs) < 1000, `network_timeline shows a state on both sides (tick ${arrived?.tick}, ${travelMs}ms apart)`)
    const handled = timeline.entries.findLast(e => e.side === 'server' && e.type === 'command')
    const input = timeline.entries.find(e => e.side === 'client' && e.type === 'command' && e.sequenceId === handled?.sequenceId)
    check(input && handled, `and an input on both sides (seq ${handled?.sequenceId}, ${handled && input && new Date(handled.time) - new Date(input.time)}ms apart)`)
    const events = await data('network_timeline', { sinceMs: 60000, eventsOnly: true })
    check(events.entries.some(e => e.side === 'server' && e.type === 'sync_enter' && e.info.entities.includes(playerId)), 'and, events only, the player coming into its own sync range')
    check(events.entries.some(e => e.side === 'client' && e.type === 'connect'), 'next to the tab\'s own connect')

    await player.evaluate(() => console.error('e2e marker', { id: 1 }))
    const errorLogs = await data('client_logs', { level: 'error', contains: 'e2e marker' })
    check(errorLogs.entries.length === 1 && errorLogs.entries[0].message === 'e2e marker {"id":1}', 'client_logs has the console error')
    const allLogs = await data('client_logs', { contains: 'Socket connection established' })
    check(allLogs.matched === 1, 'and the engine logger output from the start of the page')

    const shot = await call('client_screenshot', { maxWidth: 600 })
    const image = Buffer.from(shot.content[0].data, 'base64')
    writeFileSync(join(screenshots, 'client.jpg'), image)
    check(shot.content[0].type === 'image' && image[0] === 0xFF && image[1] === 0xD8 && image.length > 5000, `client_screenshot returns a JPEG (${image.length} bytes, ${shot.content[1].text})`)

    const traced = await data('client_trace', { durationMs: 1500, savePath: join(screenshots, 'trace.json') })
    check(traced.frames > 5 && traced.renderCpu?.p50 > 0 && traced.perFrame.drawCalls > 0, `client_trace records frames (${traced.frames} frames, render CPU p50 ${traced.renderCpu?.p50}ms, ${traced.perFrame.drawCalls} draw calls, ${traced.bottleneck.verdict})`)
    check(traced.passes.some(p => p.name === 'RenderPass'), 'and times the composer passes')
    check(traced.js?.hotFunctions.length > 0, `and samples JS stacks through the Document-Policy header (${traced.notes.join('; ') || 'no notes'})`)
    check(JSON.parse(readFileSync(traced.traceFile, 'utf8')).traceEvents.length > traced.frames, `and saves a trace file (${traced.traceFile})`)

    log('\n== editor')
    const editor = await context.newPage()
    editor.on('pageerror', error => errors.push(`editor: ${error.message}`))
    watchPage(editor, 'editor', problems)
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

    log('\n== editor network panel')
    await (await waitForEditorUi(editor, errors, problems)).click()
    await editor.getByText('sv_state').first().waitFor({ timeout: 10000 })
    check(await editor.getByText('Alice').count() === 1, 'the Network panel lists the server\'s packets and the players it syncs')

    await editor.getByLabel('Server ghosts').check()
    await editor.getByLabel('Sync radius').check()
    await waitFor(editor, () => window.Game.editor.networkOverlay.counts.ghosts > 0 && window.Game.editor.networkOverlay.counts.rings === 1, undefined, 10000)
    const overlay = await editor.evaluate((id) => {
      const { group, counts } = window.Game.editor.networkOverlay
      const ghost = group.getObjectByName(`ServerGhost:${id}`)
      const ring = group.getObjectByName(`SyncRing:${id}`)
      return { counts, ghost: ghost && { x: ghost.position.x, z: ghost.position.z }, ringScale: ring?.scale.x }
    }, playerId)
    const onServer = (await data('get_entity', { id: playerId })).position
    check(overlay.ghost && Math.hypot(overlay.ghost.x - onServer.x, overlay.ghost.z - onServer.z) < 0.5, 'the overlay draws the player\'s ghost where the server has it')
    check(overlay.ringScale === 200, 'and a ring of the sync distance around it')
    await editor.screenshot({ path: join(screenshots, 'editor-network.png') })

    await editor.close()
    let remaining
    for (let tries = 0; tries < 20; tries++) {
      remaining = (await data('list_clients')).clients
      if (remaining.length === 1)
        break
      await delay(250)
    }
    check(remaining.length === 1 && remaining[0].playerId === playerId, 'a closed tab leaves the list')

    check(errors.length === 0, `no page errors${errors.length ? `:\n  ${errors.join('\n  ')}` : ''}`)
    log('\nmcp end-to-end test passed')
  }
  catch (err) {
    await reportFailure(context, server, errors, problems).catch(() => {})
    throw err
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
