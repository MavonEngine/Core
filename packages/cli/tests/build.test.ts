import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBuildArgs, summarizeReleaseAssets } from '../src/commands/build'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-build-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseBuildArgs', () => {
  it('resolves --cwd', () => {
    expect(parseBuildArgs(['--cwd', 'game'], '/home')).toEqual({ cwd: resolve('/home', 'game') })
  })

  it('returns help', () => {
    expect(parseBuildArgs(['--help'])).toBe('help')
  })
})

describe('summarizeReleaseAssets', () => {
  it('lists what each enabled plugin ships, and the warnings', () => {
    writeFileSync(join(dir, 'mavonengine.json'), JSON.stringify({
      plugins: { forest: { prefabs: ['Tree'] }, hud: {}, off: { enabled: false } },
    }))
    const asset = { package: 'forest', from: '/x', to: 'plugins/forest/tree.glb', path: 'tree.glb' }

    expect(summarizeReleaseAssets(dir, [asset, { ...asset, path: 'bark.png' }], ['hud: asset gone.png not found'])).toBe([
      '',
      'Plugins in mavonengine.json:',
      '  forest: 2 assets, prefabs: Tree',
      '  hud: 0 assets',
      '  warning: hud: asset gone.png not found',
      '',
    ].join('\n'))
  })

  it('says nothing without plugins', () => {
    writeFileSync(join(dir, 'mavonengine.json'), '{}')

    expect(summarizeReleaseAssets(dir, [], [])).toBe('')
  })
})
