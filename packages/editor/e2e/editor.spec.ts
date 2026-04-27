import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  // Returns a Promise so Playwright waits for it rather than re-polling.
  // Safe because editorRegistered fires after RAPIER.init() + dynamic import,
  // both of which start after page load — so it can't have fired before we listen.
  await page.waitForFunction(() =>
    new Promise<boolean>((resolve) => {
      const tryRegister = () => {
        const game = (window as any).Game
        if (game) {
          game.on('editorRegistered', () => resolve(true))
        }
        else {
          requestAnimationFrame(tryRegister)
        }
      }
      tryRegister()
    }),
  )
})

test('editor opens on Insert key press', async ({ page }) => {
  await page.keyboard.press('Insert')

  // The editor mounts its React UI into #ui and sets the page title
  await expect(page).toHaveTitle('MavonEngine | Editor')
})

test('editor opens on Period key press', async ({ page }) => {
  await page.keyboard.press('.')

  await expect(page).toHaveTitle('MavonEngine | Editor')
})

test('shade mode switches to wireframe', async ({ page }) => {
  await page.keyboard.press('Insert')
  await expect(page).toHaveTitle('MavonEngine | Editor')

  const wireframeBtn = page.getByTitle('Wireframe')
  await wireframeBtn.click()

  // Active button gets an extra CSS class — verify it's no longer the only button without it
  const solidBtn = page.getByTitle('Solid')
  await expect(solidBtn).not.toHaveClass(/active/i)
  await expect(wireframeBtn).toHaveClass(/active/i)
})

test('scene explorer renders initial objects', async ({ page }) => {
  await page.keyboard.press('Insert')
  await expect(page).toHaveTitle('MavonEngine | Editor')

  // Verify AmbientLight exists in the actual Three.js scene by traversing it.
  const hasAmbientLight = await page.evaluate(() => {
    let found = false
    window.Game?.scene?.traverse((obj) => {
      if (obj.type === 'AmbientLight')
        found = true
    })
    return found
  })
  expect(hasAmbientLight).toBe(true)

  // Also confirm the scene explorer UI reflects it.
  // toBeAttached (not toBeVisible) because the panel ancestor uses overflow:hidden for sizing.
  await expect(page.getByTestId('scene-explorer').getByText('AmbientLight')).toBeAttached()
})
