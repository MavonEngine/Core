import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePublishArgs, runPublishCommand } from '../src/commands/publish'

let dir: string

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function io() {
  let output = ''
  return {
    write: (text: string) => void (output += text),
    output: () => output,
  }
}

const layout = () => join(dir, 'resources', '@mavonengine', 'mail', 'layout.html')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-publish-'))
  write(join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@mavonengine/core': '0.0.25' },
    scripts: { dev: 'x' },
  }))
  const mail = join(dir, 'node_modules', '@mavonengine', 'mail')
  write(join(mail, 'package.json'), JSON.stringify({
    name: '@mavonengine/mail',
    version: '0.0.2',
    mavonengine: { target: 'server', server: './index.js', publish: 'publish' },
  }))
  write(join(mail, 'publish', 'layout.html'), '<html>{{{ content }}}</html>')
  write(join(dir, 'node_modules', 'plain-lib', 'package.json'), JSON.stringify({ name: 'plain-lib' }))
  write(join(dir, 'node_modules', '@acme', 'hud', 'package.json'), JSON.stringify({
    name: '@acme/hud',
    mavonengine: { target: 'client', client: './c.js' },
  }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parsePublishArgs', () => {
  it('takes the packages and flags', () => {
    expect(parsePublishArgs([
      '@mavonengine/mail',
      '--force',
      '--cwd',
      'game',
    ], '/home')).toEqual({
      cwd: resolve('/home', 'game'),
      packages: ['@mavonengine/mail'],
      force: true,
    })
    expect(parsePublishArgs(['-h'])).toBe('help')
    expect(() => parsePublishArgs([])).toThrow('name the plugin to publish')
    expect(() => parsePublishArgs(['x', '--nope'])).toThrow()
  })
})

describe('mavonengine asset:publish', () => {
  it('copies the plugin\'s files into the project, from anywhere inside it', async () => {
    mkdirSync(join(dir, 'server', 'src'), { recursive: true })
    const out = io()

    expect(await runPublishCommand({
      cwd: join(dir, 'server', 'src'),
      packages: ['@mavonengine/mail'],
      force: false,
    }, out)).toBe(0)

    expect(readFileSync(layout(), 'utf8')).toBe('<html>{{{ content }}}</html>')
    expect(out.output()).toBe('@mavonengine/mail:\n  published  resources/@mavonengine/mail/layout.html\n')
  })

  it('keeps the project\'s changes, unless --force', async () => {
    await runPublishCommand({
      cwd: dir,
      packages: ['@mavonengine/mail'],
      force: false,
    }, io())
    writeFileSync(layout(), '<html>mine</html>')

    const again = io()
    expect(await runPublishCommand({
      cwd: dir,
      packages: ['@mavonengine/mail'],
      force: false,
    }, again)).toBe(0)
    expect(readFileSync(layout(), 'utf8')).toBe('<html>mine</html>')
    expect(again.output()).toContain('kept       resources/@mavonengine/mail/layout.html (you have it already, --force replaces it)')

    const forced = io()
    await runPublishCommand({
      cwd: dir,
      packages: ['@mavonengine/mail'],
      force: true,
    }, forced)
    expect(readFileSync(layout(), 'utf8')).toBe('<html>{{{ content }}}</html>')
    expect(forced.output()).toContain('replaced   resources/@mavonengine/mail/layout.html')
  })

  it('says why for packages it can\'t publish, and publishes the others', async () => {
    const out = io()
    expect(await runPublishCommand({
      cwd: dir,
      packages: [
        '@mavonengine/nope',
        'plain-lib',
        '@acme/hud',
        '@mavonengine/mail',
      ],
      force: false,
    }, out)).toBe(1)

    expect(out.output()).toContain('@mavonengine/nope isn\'t installed, or is no MavonEngine plugin. Install it with: mavonengine install @mavonengine/nope')
    expect(out.output()).toContain('plain-lib isn\'t installed, or is no MavonEngine plugin')
    expect(out.output()).toContain('@acme/hud has no files to publish')
    expect(existsSync(layout())).toBe(true)
  })

  it('needs a project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mavonengine-nowhere-'))
    const out = io()
    try {
      expect(await runPublishCommand({
        cwd: outside,
        packages: ['@mavonengine/mail'],
        force: false,
      }, out)).toBe(1)
      expect(out.output()).toContain('No MavonEngine project found')
    }
    finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
