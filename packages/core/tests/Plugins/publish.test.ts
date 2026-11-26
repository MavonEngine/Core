import type { InstalledPlugin } from '../../src/Plugins/ProjectConfig'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginConfigError, readPluginManifest } from '../../src/Plugins/ProjectConfig'
import { publishedDir, publishedFile, publishFiles } from '../../src/Plugins/publish'

let root: string

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function mailPlugin(manifest: Record<string, unknown> = { target: 'server', server: './index.js', publish: 'publish' }): InstalledPlugin {
  const dir = join(root, 'node_modules', '@mavonengine', 'mail')
  write(join(dir, 'package.json'), JSON.stringify({ name: '@mavonengine/mail', version: '1.0.0', mavonengine: manifest }))
  write(join(dir, 'publish', 'layout.html'), '<html>{{{ content }}}</html>')
  write(join(dir, 'publish', 'partials', 'footer.html'), '<footer></footer>')
  return readPluginManifest(root, '@mavonengine/mail')!
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mavonengine-publish-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('publishing a plugin\'s files', () => {
  it('copies them into resources/<package>/, keeping the directories', () => {
    const published = publishFiles(root, mailPlugin())

    const dir = join(root, 'resources', '@mavonengine', 'mail')
    expect(publishedDir(root, '@mavonengine/mail')).toBe(dir)
    expect(published).toEqual([
      {
        path: 'layout.html',
        to: join(dir, 'layout.html'),
        status: 'published',
      },
      {
        path: 'partials/footer.html',
        to: join(dir, 'partials', 'footer.html'),
        status: 'published',
      },
    ])
    expect(readFileSync(join(dir, 'layout.html'), 'utf8')).toBe('<html>{{{ content }}}</html>')
  })

  it('keeps what the project has already, unless forced', () => {
    const plugin = mailPlugin()
    publishFiles(root, plugin)
    const layout = join(publishedDir(root, plugin.package), 'layout.html')
    writeFileSync(layout, '<html>mine</html>')

    expect(publishFiles(root, plugin).map(f => f.status)).toEqual(['kept', 'kept'])
    expect(readFileSync(layout, 'utf8')).toBe('<html>mine</html>')

    expect(publishFiles(root, plugin, { force: true }).map(f => f.status)).toEqual(['replaced', 'replaced'])
    expect(readFileSync(layout, 'utf8')).toBe('<html>{{{ content }}}</html>')
  })

  it('refuses a plugin that publishes nothing, or whose directory is missing or outside it', () => {
    expect(() => publishFiles(root, mailPlugin({ target: 'server', server: './index.js' }))).toThrow('has no files to publish')
    expect(() => publishFiles(root, mailPlugin({ target: 'server', server: './index.js', publish: 'nope' }))).toThrow('is missing')
    expect(() => publishFiles(root, mailPlugin({ target: 'server', server: './index.js', publish: '../..' }))).toThrow('inside the package')
    expect(() => mailPlugin({ target: 'server', server: './index.js', publish: 3 })).toThrow(PluginConfigError)
  })

  it('finds the project\'s copy of a file, and nothing outside the plugin\'s directory', () => {
    publishFiles(root, mailPlugin())
    write(join(root, 'resources', '@mavonengine', 'other.html'), 'x')

    expect(publishedFile(root, '@mavonengine/mail', 'layout.html')).toBe(join(root, 'resources', '@mavonengine', 'mail', 'layout.html'))
    expect(publishedFile(root, '@mavonengine/mail', 'nope.html')).toBeUndefined()
    expect(publishedFile(root, '@mavonengine/mail', 'partials')).toBeUndefined()
    expect(publishedFile(root, '@mavonengine/mail', '../other.html')).toBeUndefined()
    expect(publishedFile(root, '@acme/other', 'layout.html')).toBeUndefined()
  })
})
