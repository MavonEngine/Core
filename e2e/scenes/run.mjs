/**
 * End-to-end test for scenes, run against packages/multiplayer-template in dev mode:
 *
 * 1. boots the game server, which loads scenes/main.json and builds its tree field (colliders only)
 * 2. a player joins: the client loads the same scene (sky, lights, ground) and renders the trees the server sends
 * 3. a second client joins and opens the editor: it keeps the connection and shows the live trees and the player,
 *    but stops being a player itself, so the metrics count one player
 * 4. the editor changes the tree field's props and saves: the file is written, the server reloads it and
 *    both the player and the editor get the new trees
 *
 * Needs Chrome, core built and the template's dependencies installed. The scene file is restored afterwards.
 *
 *   node e2e/scenes/run.mjs
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { base, check, log, run, snapshotFiles, startServer, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = join(here, 'screenshots')
const sceneFile = join(template, 'scenes', 'main.json')

/** Trees rendered by the client: instances of the first instanced mesh of World/Trees */
function treeCount(page) {
  return page.evaluate(() => {
    const trees = window.Game.world.entities.items.get('trees')
    return trees?.instancedMeshes?.[0]?.count ?? 0
  })
}

async function waitFor(page, fn, arg, timeout = 30000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 200 })
}

async function joinGame(page, name) {
  await page.goto(base)
  await page.locator('.name-input').fill(name)
  await page.locator('.join-btn').click()
  await waitFor(page, () => window.Game?.activeScene?.name === 'main')
}

async function main() {
  const restore = snapshotFiles([sceneFile])
  let server
  let browser
  const errors = []

  rmSync(screenshots, { recursive: true, force: true })
  mkdirSync(screenshots, { recursive: true })

  try {
    log('\n== server')
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1' })
    await delay(500)
    check(server.output().includes('Loaded scene main (1 of 4 objects on the server)'), 'the server loads scenes/main.json and builds only the tree field')

    log('\n== player')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const watch = (page, who) => {
      page.on('console', (message) => {
        if (message.type() === 'error')
          errors.push(`${who}: ${message.text()}`)
      })
      page.on('pageerror', error => errors.push(`${who}: ${error.message}`))
    }

    const player = await context.newPage()
    watch(player, 'player')
    await joinGame(player, 'Alice')
    const objects = await player.evaluate(() => window.Game.activeScene.getEntries().map(e => [e.data.id, !!e.object]))
    check(JSON.stringify(objects) === JSON.stringify([['ambient_light', true], ['sun', true], ['ground', true], ['forest', false]]), 'the client builds the lights and ground, not the server\'s tree field')
    check(await player.evaluate(() => window.Game.scene.background?.getHexString()) === '87ceeb', 'the sky colour comes from the scene settings')
    await waitFor(player, () => (window.Game.world.entities.items.get('trees')?.instancedMeshes?.[0]?.count ?? 0) === 15)
    check(true, 'the player renders the 15 trees the server sent')

    log('\n== editor')
    const editor = await context.newPage()
    watch(editor, 'editor')
    await joinGame(editor, 'Editor')
    await waitFor(editor, () => window.Game.world.entities.items.size > 4)
    const before = await (await fetch(`${base}/api/game/metrics`)).json()
    check(before.players.length === 2, 'both clients are players before the editor opens')

    await editor.locator('canvas').click({ position: { x: 700, y: 450 } })
    await editor.keyboard.press('Period')
    await waitFor(editor, () => !!window.Game.editor && document.title === 'MavonEngine | Editor')
    await delay(1000)

    const after = await (await fetch(`${base}/api/game/metrics`)).json()
    check(after.players.length === 1 && after.players[0].displayName === 'Alice', 'the editor is no player in the metrics anymore')
    check(server.output().includes('opened the editor, it is no longer a player'), 'the server logs it')
    check(await player.evaluate(() => [...window.Game.world.entities.items.values()].filter(e => e.$typeName && e.id !== 'localPlayer').length) === 0, 'the player no longer sees the editor\'s character')

    check(await treeCount(editor) === 15, 'the editor shows the trees the server seeded')
    await waitFor(editor, () => [...window.Game.world.entities.items.values()].some(e => e.$typeName && !window.Game.activeScene.entryOf(e)))
    check(true, 'the editor shows the other player live, from the server')
    check(await editor.evaluate(() => window.Game.activeScene.getEntries().filter(e => e.object).length) === 3, 'the editor keeps the scene it was playing in')
    check(await editor.evaluate(() => window.Game.activeScene.isDirty()) === false, 'opening the editor leaves the scene unchanged')
    await editor.getByRole('tab', { name: 'Scene' }).click()
    await editor.getByText('Forest').waitFor()
    check(await editor.getByText('server', { exact: true }).isVisible(), 'the Scene panel marks the tree field as server-built')
    await editor.screenshot({ path: join(screenshots, '1-editor.png') })

    log('\n== save')
    await editor.getByText('Forest').click()
    const count = editor.locator('label', { hasText: 'count' }).locator('input')
    await count.fill('40')
    await count.blur()
    await editor.keyboard.press('ControlOrMeta+KeyS')
    await waitFor(editor, () => !window.Game.activeScene.isDirty())

    const saved = JSON.parse(readFileSync(sceneFile, 'utf8'))
    const forest = saved.objects.find(o => o.id === 'forest')
    check(forest.props.count === 40, 'the save writes the new tree count to scenes/main.json')
    check(saved.objects.length === 4 && saved.settings.fog.density === 0.012, 'the rest of the scene is saved as it was')

    await waitFor(player, () => (window.Game.world.entities.items.get('trees')?.instancedMeshes?.[0]?.count ?? 0) === 40)
    check(true, 'the server reloads the scene and the player gets 40 trees')
    await waitFor(editor, () => (window.Game.world.entities.items.get('trees')?.instancedMeshes?.[0]?.count ?? 0) === 40)
    check(true, 'the editor gets the new trees too')
    check(server.output().includes('Scene main.json changed, reloaded it'), 'the server logs the reload')
    await editor.screenshot({ path: join(screenshots, '2-after-save.png') })

    log('\n== editor opened from the main menu, without joining')
    const watcher = await context.newPage()
    watch(watcher, 'watcher')
    await watcher.goto(base)
    await waitFor(watcher, () => window.Game?.activeScene?.name === 'main')
    await watcher.locator('canvas').click({ position: { x: 700, y: 450 }, force: true })
    await watcher.keyboard.press('Period')
    await waitFor(watcher, () => (window.Game.world.entities.items.get('trees')?.instancedMeshes?.[0]?.count ?? 0) === 40)
    check(true, 'it connects anyway and shows the trees the server seeded')
    await waitFor(watcher, () => [...window.Game.world.entities.items.values()].some(e => e.$typeName))
    check(true, 'and the player, live')
    await delay(500)
    const watched = await (await fetch(`${base}/api/game/metrics`)).json()
    check(watched.players.length === 1, 'it never counts as a player')
    check(!server.output().includes(' joined the game!') || server.output().split(' joined the game!').length === 3, 'it never joins, so nobody is told it came in')

    log('\n== custom panel')
    await editor.evaluate(() => window.Game.editor.addPanel({
      id: 'e2e',
      title: 'E2E Tools',
      location: 'bottom',
      mount(el) {
        el.textContent = `players: ${window.Game.world.entities.items.size}`
      },
    }))
    await editor.getByRole('tab', { name: 'E2E Tools' }).click()
    check(await editor.getByText('players:').isVisible(), 'a custom panel docks as a tab next to Assets')
    await editor.screenshot({ path: join(screenshots, '3-custom-panel.png') })

    const relevant = errors.filter(e => !e.includes('favicon'))
    check(relevant.length === 0, `no console errors${relevant.length ? `:\n${relevant.join('\n')}` : ''}`)
    log('\nAll scene checks passed')
  }
  catch (err) {
    log(`\n== server output\n${server?.output().slice(-4000)}`)
    throw err
  }
  finally {
    await browser?.close()
    await server?.stop()
    restore()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
