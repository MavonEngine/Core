/**
 * End-to-end test for the built editor, the way a project that installed @mavonengine/core and
 * @mavonengine/editor from npm loads them:
 *
 * The template's Vite config aliases both packages to their src/ in this repository, so the other tests
 * never load dist/. Bundling problems (a missing external, a require() left in a chunk, a chunk that
 * doesn't load) only show up in dist. Here MAVONENGINE_USE_DIST=1 turns the aliases off, so the template
 * resolves the packages through node_modules, then the test opens the editor in Chrome and checks that
 * its UI mounts with no errors.
 *
 * Needs Chrome, core and the editor built and npm-linked into the template, and the template's
 * dependencies installed.
 *
 *   node e2e/editor-dist/run.mjs
 */
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { base, check, log, repo, run, startServer, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = join(here, 'screenshots')

/** The package `name` in the template's node_modules must be this repository's, or the test checks a published one */
function checkLinked(name, dir) {
  const linked = realpathSync(join(template, 'node_modules', name))
  const expected = realpathSync(join(repo, 'packages', dir))
  check(linked === expected, `${name} in the template is this repository's packages/${dir}${linked === expected ? '' : ` (it is ${linked}, run npm link in packages/${dir} and the template)`}`)
}

async function main() {
  let server
  let browser
  const errors = []

  rmSync(screenshots, { recursive: true, force: true })
  mkdirSync(screenshots, { recursive: true })

  try {
    log('\n== setup')
    checkLinked('@mavonengine/core', 'core')
    checkLinked('@mavonengine/editor', 'editor')
    // Deps pre-bundled while the aliases pointed at src/ would be reused otherwise
    rmSync(join(template, 'client/node_modules/.vite'), { recursive: true, force: true })
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1', MAVONENGINE_USE_DIST: '1' })

    log('\n== editor')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(message.text())
    })
    page.on('pageerror', error => errors.push(error.stack ?? error.message))

    await page.goto(base)
    await page.waitForFunction(() => window.Game?.activeScene?.name === 'main', null, { timeout: 60000, polling: 200 })
    check(true, 'the game loads with core from dist')

    await page.locator('canvas').click({ position: { x: 700, y: 450 }, force: true })
    await page.keyboard.press('Period')
    await page.waitForFunction(() => !!window.Game.editor && document.title === 'MavonEngine | Editor', null, { timeout: 30000, polling: 200 })
    check(true, 'the editor boots')

    // The UI is loaded with a dynamic import after the editor boots; a chunk that fails to load is logged, not thrown,
    // so stop waiting as soon as an error shows up
    const sceneTab = page.getByRole('tab', { name: 'Scene' })
    const deadline = Date.now() + 30000
    while (!errors.length && Date.now() < deadline && !await sceneTab.isVisible())
      await delay(200)
    check(await sceneTab.isVisible(), `the editor's UI mounts${errors.length ? `:\n${errors.join('\n')}` : ''}`)

    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name))
    check(loaded.some(url => url.includes('/editor/dist/')) && !loaded.some(url => url.includes('/editor/src/')), 'the editor came from dist, not src')
    check(!loaded.some(url => url.includes('/core/src/')), 'core came from dist, not src')
    await page.screenshot({ path: join(screenshots, 'editor.png') })

    const relevant = errors.filter(e => !e.includes('favicon'))
    check(relevant.length === 0, `no console errors${relevant.length ? `:\n${relevant.join('\n')}` : ''}`)
    log('\nAll editor dist checks passed')
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
