/**
 * End-to-end test for VR, run against packages/multiplayer-template in dev mode with an emulated Meta Quest 3
 * (iwer, the Immersive Web Emulation Runtime) standing in for a headset:
 *
 * 1. the template sees WebXR, shows the Enter VR button and a player joins
 * 2. entering VR: frames render through the session, the headset drives the camera and both controllers connect
 * 3. the left stick walks the character through the server, the way the player looks, and the chase view
 *    follows it every rendered frame
 * 4. a right stick flick snap turns the view around the character
 * 5. leaving VR hands the camera back to the desktop orbit controls
 *
 * Needs Chrome, core built and the template's dependencies installed.
 *
 *   node e2e/xr/run.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { base, check, log, run, startServer, template } from '../helpers.mjs'

const require = createRequire(import.meta.url)
const iwer = readFileSync(require.resolve('iwer/build/iwer.min.js'), 'utf8')

async function waitFor(page, fn, arg, timeout = 30000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 100 })
}

/** Install the emulated headset before the game's scripts run. Chrome has its own navigator.xr without a device */
function installHeadset() {
  const device = new window.IWER.XRDevice(window.IWER.metaQuest3)
  device.installRuntime({ forceInstall: true })
  window.__headset = device
}

/**
 * How many frames the renderer draws, waiting until it has drawn `count` or `ms` have passed. Software GL on a CI
 * runner can take far longer per frame than a desktop, so a fixed window would fail a session that is rendering
 */
async function framesDrawn(page, count, ms = 10000) {
  const frame = () => page.evaluate(() => window.Game.renderer.instance.info.render.frame)
  const start = await frame()
  const until = Date.now() + ms
  while (true) {
    const drawn = await frame() - start
    if (drawn >= count || Date.now() > until)
      return drawn
    await delay(100)
  }
}

/**
 * Poll `fn` until it gives something truthy or `ms` have passed, and give its last value. The game reads the sticks
 * and keys once a frame, and a CI runner can take hundreds of ms over one, so input is held until the game reacts
 */
async function until(fn, ms = 15000) {
  const end = Date.now() + ms
  while (true) {
    const value = await fn()
    if (value || Date.now() > end)
      return value
    await delay(100)
  }
}

/** Let the game see an input change: a few frames, then time for the server's answer */
async function settle(page) {
  await framesDrawn(page, 3)
  await delay(600)
}

const stick = (page, hand, x, y) => page.evaluate(([hand, x, y]) => window.__headset.controllers[hand].updateAxes('thumbstick', x, y), [hand, x, y])

/** The character and the camera, relative to the character, in the world */
function pose(page) {
  return page.evaluate(() => {
    const game = window.Game
    game.camera.updateWorldPosition()
    const player = game.localPlayer.position
    const camera = game.camera.worldPosition
    return {
      player: player.toArray(),
      offset: camera.clone().sub(player).toArray(),
      yaw: game.localPlayer.rotation.y,
    }
  })
}

async function main() {
  let server
  let browser
  const errors = []

  try {
    log('\n== server')
    await run('npm', ['run', 'build'], {
      cwd: join(template, 'server'),
    })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1' })

    log('\n== join')
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    })
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(message.text())
    })
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(`${iwer}\n;(${installHeadset})()`)

    await page.goto(base)
    await waitFor(page, () => document.querySelector('#VRButton')?.textContent === 'ENTER VR')
    check(true, 'the template shows the Enter VR button when the browser can do VR')
    await page.locator('.name-input').fill('Vera')
    await page.locator('.join-btn').click()
    await waitFor(page, () => window.Game?.localPlayer && window.Game.activeScene?.name === 'main')
    check(true, 'a player joins')

    log('\n== enter VR')
    await page.locator('#VRButton').click()
    await waitFor(page, () => window.Game.renderer.xrPresenting, null, 10000)
    check(true, 'clicking the button enters a VR session')
    const drawn = await framesDrawn(page, 6)
    check(drawn >= 6, `frames render through the session (${drawn})`)
    await waitFor(page, () => window.Game.input.xr.left.connected && window.Game.input.xr.right.connected)
    check(true, 'both controllers connect, each to its hand')

    // Let the character land and the smoothed view catch up with it
    await delay(1500)
    const start = await pose(page)
    // The chase view: 7m behind (+Z with the default facing) and 3m above the aim point, 1m over the feet
    check(Math.abs(start.offset[2] - 7) < 0.5 && Math.abs(start.offset[1] - 4) < 0.5, `the view sits behind and above the character (${start.offset.map(n => n.toFixed(2))})`)

    log('\n== walk')
    await stick(page, 'left', 0, -1)
    await until(async () => (await pose(page)).player[2] - start.player[2] < -2.5)
    await stick(page, 'left', 0, 0)
    await settle(page)
    const walked = await pose(page)
    const dz = walked.player[2] - start.player[2]
    check(dz < -2 && Math.abs(walked.player[0] - start.player[0]) < 0.5, `pushing the left stick forward walks the character the way the player looks, through the server (moved ${dz.toFixed(2)}m along Z)`)
    check(Math.abs(walked.yaw) < 0.1, `the character faces the way it walks (yaw ${walked.yaw.toFixed(3)})`)
    check(Math.abs(walked.offset[2] - 7) < 0.5, `the view follows it (${walked.offset.map(n => n.toFixed(2))})`)

    // Pushed right: walks along +X, facing it
    await stick(page, 'left', 1, 0)
    await until(async () => (await pose(page)).player[0] - walked.player[0] > 1.5)
    await stick(page, 'left', 0, 0)
    await settle(page)
    const strafed = await pose(page)
    check(strafed.player[0] - walked.player[0] > 1, `pushing it right walks right (moved ${(strafed.player[0] - walked.player[0]).toFixed(2)}m along X)`)
    check(Math.abs(strafed.yaw + Math.PI / 2) < 0.15, `and turns the character to face right (yaw ${strafed.yaw.toFixed(3)})`)

    // Smooth in the headset: the character's position only changes 30 times a second, unevenly, so its model
    // follows it every rendered frame and the view follows the model. Measured while walking
    const smooth = await page.evaluate(async () => {
      const game = window.Game
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const model = game.localPlayer.graphicalComponent.instance
      window.__headset.controllers.left.updateAxes('thumbstick', 0, -1)
      // Until it walks, then a little longer to get up to speed
      const still = game.localPlayer.position.clone()
      for (let waited = 0; game.localPlayer.position.distanceTo(still) < 0.5 && waited < 15000; waited += 50)
        await sleep(50)
      await sleep(300)
      const jitter = []
      let moved = 0
      let frames = 0
      let lastRelative
      const lastModel = model.position.clone()
      const render = game.renderer.update.bind(game.renderer)
      game.renderer.update = (delta) => {
        render(delta)
        frames++
        game.camera.updateWorldPosition()
        const relative = model.position.clone().sub(game.camera.worldPosition)
        if (lastRelative)
          jitter.push(relative.distanceTo(lastRelative))
        if (!model.position.equals(lastModel))
          moved++
        lastRelative = relative
        lastModel.copy(model.position)
      }
      await sleep(1000)
      game.renderer.update = render
      window.__headset.controllers.left.updateAxes('thumbstick', 0, 0)
      return {
        frames,
        moved,
        jitter: Math.max(...jitter),
      }
    })
    check(smooth.frames > 0 && smooth.moved === smooth.frames, `the character's model moves every rendered frame (${smooth.moved} of ${smooth.frames})`)
    check(smooth.jitter < 0.01, `and holds still in the view while walking (${(smooth.jitter * 100).toFixed(2)}cm most from one frame to the next)`)

    log('\n== snap turn')
    await settle(page)
    const before = await page.evaluate(() => window.Game.camera.rig.rotation.y)
    await stick(page, 'right', 1, 0)
    await until(async () => await page.evaluate(() => window.Game.camera.rig.rotation.y) !== before)
    await stick(page, 'right', 0, 0)
    await settle(page)
    const turned = await page.evaluate(() => window.Game.camera.rig.rotation.y) - before
    check(Math.abs(turned * 180 / Math.PI + 30) < 1, `a right stick flick snap turns the view 30 degrees right, once (${(turned * 180 / Math.PI).toFixed(1)})`)
    const around = await pose(page)
    const distance = Math.hypot(around.offset[0], around.offset[2])
    // Looking 30 degrees further right swings the view round to the character's left: 7m * sin(30) = 3.5m
    check(Math.abs(distance - 7) < 0.5 && Math.abs(around.offset[0] + 3.5) < 0.5, `around the character, keeping its distance (${around.offset.map(n => n.toFixed(2))})`)

    log('\n== keyboard and mouse in VR')
    const rigYaw = () => page.evaluate(() => window.Game.camera.rig.rotation.y)
    // Looking 30 degrees right of -Z after the snap turn
    const forward = [
      Math.sin(Math.PI / 6),
      -Math.cos(Math.PI / 6),
    ]
    const beforeKeys = await pose(page)
    await page.keyboard.down('KeyW')
    await until(async () => {
      const now = (await pose(page)).player
      return Math.hypot(now[0] - beforeKeys.player[0], now[2] - beforeKeys.player[2]) > 2.5
    })
    await page.keyboard.up('KeyW')
    await settle(page)
    const keyed = await pose(page)
    const kx = keyed.player[0] - beforeKeys.player[0]
    const kz = keyed.player[2] - beforeKeys.player[2]
    const along = (kx * forward[0] + kz * forward[1]) / Math.hypot(kx, kz)
    check(Math.hypot(kx, kz) > 2 && along > 0.95, `W walks the character the way the player looks (${Math.hypot(kx, kz).toFixed(2)}m, ${along.toFixed(3)} along the view)`)

    const beforeQ = await rigYaw()
    await page.keyboard.press('KeyQ')
    await until(async () => await rigYaw() !== beforeQ)
    await framesDrawn(page, 2)
    const q = (await rigYaw() - beforeQ) * 180 / Math.PI
    check(Math.abs(q - 30) < 1, `Q snap turns the view 30 degrees left (${q.toFixed(1)})`)
    const beforeE = await rigYaw()
    await page.keyboard.press('KeyE')
    await until(async () => await rigYaw() !== beforeE)
    await framesDrawn(page, 2)
    const e = (await rigYaw() - beforeE) * 180 / Math.PI
    check(Math.abs(e + 30) < 1, `E snap turns it 30 degrees right (${e.toFixed(1)})`)

    const beforeDrag = await rigYaw()
    await page.mouse.move(600, 400)
    await page.mouse.down()
    for (let x = 610; x <= 700; x += 10)
      await page.mouse.move(x, 400)
    await page.mouse.up()
    await until(async () => await rigYaw() !== beforeDrag)
    await framesDrawn(page, 2)
    const dragged = (await rigYaw() - beforeDrag) * 180 / Math.PI
    check(dragged < -20 && dragged > -40, `dragging the mouse 100px right turns the view right (${dragged.toFixed(1)} degrees)`)
    // Moving the mouse without a button held leaves the view alone
    const beforeHover = await rigYaw()
    await page.mouse.move(800, 400)
    await framesDrawn(page, 2)
    check(await rigYaw() === beforeHover, 'moving the mouse without dragging leaves the view alone')

    log('\n== mirror')
    // The emulator reports a Quest's browser, where the page is hidden in VR: the template leaves the mirror off there
    check(!(await page.evaluate(() => window.Game.xr.mirror)), 'the template leaves the mirror off in a standalone headset\'s browser')
    // As on a PC headset
    await page.evaluate(() => window.Game.xr.mirror = true)
    const mirrored = await framesDrawn(page, 4)
    check(mirrored >= 4 && await page.evaluate(() => window.Game.renderer.instance.xr.enabled), `the session keeps rendering with the mirror on (${mirrored} frames)`)
    const mirror = await page.evaluate(() => {
      const game = window.Game
      game.camera.instance.updateWorldMatrix(true, false)
      const head = game.camera.instance.getWorldPosition(game.camera.worldPosition.clone())
      return {
        offset: game.xr.mirrorCamera.position.distanceTo(head),
        aspect: game.xr.mirrorCamera.aspect,
        window: game.sizes.width / game.sizes.height,
      }
    })
    check(mirror.offset < 0.05, `the mirror looks from the player's head (${(mirror.offset * 100).toFixed(1)}cm off)`)
    check(Math.abs(mirror.aspect - mirror.window) < 0.01, `shaped like the browser window (${mirror.aspect.toFixed(2)})`)

    log('\n== leave VR')
    await page.evaluate(() => window.Game.xr.exit())
    await waitFor(page, () => !window.Game.renderer.xrPresenting, null, 10000)
    check(await page.evaluate(() => window.Game.camera.rig.position.length() === 0 && window.Game.camera.rig.rotation.y === 0), 'the camera rig is reset for the desktop controls')
    check(await page.evaluate(() => window.Game.camera.instance.fov) === 35, 'the camera has its own field of view back, not the headset\'s')
    await framesDrawn(page, 3)
    const desktop = await pose(page)
    const orbit = Math.hypot(...desktop.offset)
    check(orbit >= 4.5 && orbit <= 25.5, `the orbit controls take the camera back around the character, within their 5-25m (${orbit.toFixed(2)}m away)`)
    check(await framesDrawn(page, 1) >= 1, 'the desktop renders again')

    const relevant = errors.filter(e => !e.includes('favicon'))
    check(relevant.length === 0, `no console errors${relevant.length
      ? `:\n${relevant.join('\n')}`
      : ''}`)
    log('\nAll VR checks passed')
  }
  catch (err) {
    log(`\n== server output\n${server?.output().slice(-4000)}`)
    throw err
  }
  finally {
    await browser?.close()
    await server?.stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
