import type { DoctorReport } from '../src/commands/doctor'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageError } from '../src/commands/dashboard'
import { formatReport, parseDoctorArgs, runDoctor, runDoctorCommand } from '../src/commands/doctor'
import { NpmRegistry } from '../src/doctor/npm'

let root: string

function write(path: string, content: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof content === 'string'
    ? content
    : JSON.stringify(content))
}

function project({ core = '0.0.25', declared = '0.0.25', config = { plugins: {} } as unknown } = {}) {
  write('package.json', {
    name: 'game',
    scripts: { dev: 'mavonengine dev' },
    dependencies: { '@mavonengine/core': declared },
  })
  write('package-lock.json', '{}')
  if (core) {
    write('node_modules/@mavonengine/core/package.json', {
      name: '@mavonengine/core',
      version: core,
      engines: { node: '>=24' },
    })
  }
  if (config !== undefined) {
    write('mavonengine.json', typeof config === 'string'
      ? config
      : config)
  }
}

function plugin(pkg: string, version: string, manifest: Record<string, unknown>, files: string[] = ['dist/server.js']) {
  write(`node_modules/${pkg}/package.json`, {
    name: pkg,
    version,
    mavonengine: { target: 'server', server: 'dist/server.js', ...manifest },
  })
  for (const file of files)
    write(`node_modules/${pkg}/${file}`, '')
}

/** A registry that knows `packages`: name → version → package.json */
function registry(packages: Record<string, { latest: string, versions: Record<string, Record<string, unknown>> }>) {
  return vi.fn(async (url: string | URL | Request) => {
    const name = decodeURIComponent(String(url).split('/').at(-1)!)
    const pkg = packages[name]
    return pkg
      ? new Response(JSON.stringify({
          'name': name,
          'dist-tags': { latest: pkg.latest },
          'versions': pkg.versions,
        }))
      : new Response('{}', { status: 404 })
  })
}

const options = { offline: false, registry: 'https://registry.example.com' }

function find(report: DoctorReport, label: string) {
  return report.findings.filter(finding => finding.label.startsWith(label))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mavonengine-doctor-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('mavonengine doctor', () => {
  it('takes its options', () => {
    expect(parseDoctorArgs([], root, {})).toEqual({
      cwd: root,
      offline: false,
      strict: false,
      json: false,
      registry: 'https://registry.npmjs.org',
    })
    expect(parseDoctorArgs(['--offline', '--strict', '--json'], root, { npm_config_registry: 'https://npm.example.com/' }))
      .toEqual({
        cwd: root,
        offline: true,
        strict: true,
        json: true,
        registry: 'https://npm.example.com/',
      })
    expect(parseDoctorArgs(['-h'])).toBe('help')
    expect(() => parseDoctorArgs(['now'])).toThrow(UsageError)
  })

  it('finds nothing wrong with a fresh project', async () => {
    project()

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })

    expect(report).toMatchObject({
      coreVersion: '0.0.25',
      packageManager: 'npm',
      errors: 0,
      warnings: 0,
    })
    expect(formatReport(report)).toContain('Everything looks fine')
  })

  it('needs the Node the CLI and core need', async () => {
    project()
    write('node_modules/@mavonengine/core/package.json', {
      name: '@mavonengine/core',
      version: '0.0.25',
      engines: { node: '>=24.5' },
    })

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })

    expect(find(report, 'Node')).toEqual([
      expect.objectContaining({ level: 'error', detail: 'needs >=24.5' }),
    ])
    expect((await runDoctor(root, { ...options, offline: true }, { nodeVersion: '22.1.0' })).findings[0].detail).toBe('needs >=24 and >=24.5')
  })

  it('says when node_modules is behind package.json', async () => {
    project({ declared: '^0.0.26' })

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })

    expect(find(report, '@mavonengine/core')).toEqual([
      expect.objectContaining({ level: 'error', detail: 'package.json asks for ^0.0.26', fix: 'npm install' }),
    ])
  })

  it('says when a newer core is out', async () => {
    project()

    const report = await runDoctor(root, options, {
      nodeVersion: '24.4.0',
      fetch: registry({
        '@mavonengine/core': {
          latest: '0.0.27',
          versions: { '0.0.25': {}, '0.0.27': {} },
        },
      }),
    })

    expect(find(report, '@mavonengine/core')).toEqual([
      expect.objectContaining({ level: 'info', detail: '0.0.27 is out' }),
    ])
    expect(report.errors + report.warnings).toBe(0)
  })

  it('checks mavonengine.json', async () => {
    project({
      config: {
        plugins: {
          a: { enabled: 'yes', prefabs: 'Tree' },
          b: true,
        },
        appUrl: 'mygame.com',
        appName: 7,
        auth: '@mavonengine/auth',
        database: 'a',
        colour: 'red',
      },
    })
    plugin('a', '1.0.0', {})

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })
    const config = report.findings.filter(finding => finding.group === 'mavonengine.json')

    expect(config.map(finding => [finding.level, finding.label])).toEqual([
      ['ok', 'mavonengine.json'],
      ['info', '"colour"'],
      ['error', 'appUrl "mygame.com"'],
      ['warn', 'appName'],
      ['error', 'auth: @mavonengine/auth'],
      ['warn', 'plugins["a"].enabled'],
      ['warn', 'plugins["a"].prefabs'],
      ['error', 'plugins["b"]'],
    ])
  })

  it('says what is wrong with a mavonengine.json it can\'t read', async () => {
    project({ config: '{ "plugins": ' })

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })

    expect(find(report, 'mavonengine.json')).toEqual([
      expect.objectContaining({
        level: 'error',
        detail: expect.stringContaining('not valid JSON'),
      }),
    ])
    expect(report.findings.filter(finding => finding.group === 'Plugins')).toEqual([])
  })

  it('checks every plugin in mavonengine.json', async () => {
    project({
      config: {
        plugins: {
          'fine': {},
          'missing': {},
          'off': { enabled: false },
          'unbuilt': {},
          'not-a-plugin': {},
          'forest': {
            prefabs: ['Tree'],
          },
          'tooling': {},
        },
      },
    })
    plugin('fine', '1.0.0', { engine: '>=0.0.22' })
    plugin('off', '1.0.0', {})
    plugin('unbuilt', '1.0.0', { engine: '>=0.0.22' }, [])
    write('node_modules/not-a-plugin/package.json', { name: 'not-a-plugin', version: '1.0.0' })
    plugin('forest', '2.0.0', {
      engine: '>=0.0.22',
      assets: {
        shared: ['bark.png'],
        prefabs: {
          Tree: ['tree.glb'],
        },
      },
    }, ['dist/server.js', 'assets/bark.png'])
    plugin('tooling', '1.0.0', { engine: '>=0.0.22', dev: 'dist/dev.js' })

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })
    const plugins = report.findings.filter(finding => finding.group === 'Plugins')

    expect(plugins.map(finding => [finding.level, finding.label, finding.detail])).toEqual([
      ['ok', 'fine 1.0.0', 'core >=0.0.22'],
      ['error', 'missing', 'in mavonengine.json but not installed'],
      ['info', 'off 1.0.0', 'turned off'],
      ['error', 'unbuilt 1.0.0', 'server entry dist/server.js not found, is the plugin built?'],
      ['error', 'not-a-plugin 1.0.0', 'not a MavonEngine plugin: its package.json has no "mavonengine" field'],
      ['warn', 'forest 2.0.0', 'asset missing from the release: tree.glb'],
      ['warn', 'tooling 1.0.0', 'dev entry dist/dev.js not found, is the plugin built?'],
    ])
  })

  it('points to the version of a plugin made for the project\'s core', async () => {
    project({
      config: {
        plugins: { '@mavonengine/auth': {}, 'old': {} },
      },
    })
    plugin('@mavonengine/auth', '0.2.0', { engine: '>=0.0.26' })
    plugin('old', '1.0.0', { engine: '^0.0.20' })

    const fetch = registry({
      '@mavonengine/core': {
        latest: '0.0.25',
        versions: { '0.0.25': {} },
      },
      '@mavonengine/auth': {
        latest: '0.2.0',
        versions: {
          '0.1.0': {
            mavonengine: { engine: '>=0.0.24' },
          },
          '0.1.1': {
            peerDependencies: { '@mavonengine/core': '>=0.0.25' },
          },
          '0.1.2-beta': {
            mavonengine: { engine: '>=0.0.25' },
          },
          '0.2.0': {
            mavonengine: { engine: '>=0.0.26' },
          },
        },
      },
      'old': {
        latest: '1.0.0',
        versions: {
          '1.0.0': {
            mavonengine: { engine: '^0.0.20' },
          },
        },
      },
    })
    const report = await runDoctor(root, options, { nodeVersion: '24.4.0', fetch })

    expect(find(report, '@mavonengine/auth')).toEqual([
      expect.objectContaining({
        level: 'error',
        detail: 'made for @mavonengine/core >=0.0.26, the project has 0.0.25',
        fix: 'mavonengine install @mavonengine/auth@0.1.1',
      }),
    ])
    expect(find(report, 'old')[0].fix).toBe('no published version supports core 0.0.25; move @mavonengine/core into ^0.0.20')
    // Each package is asked for once
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenCalledWith('https://registry.example.com/@mavonengine%2Fauth', expect.anything())
  })

  it('says when a newer plugin that fits is out', async () => {
    project({
      config: {
        plugins: { chat: {} },
      },
    })
    plugin('chat', '0.3.0', { engine: '>=0.0.22' })

    const report = await runDoctor(root, options, {
      nodeVersion: '24.4.0',
      fetch: registry({
        chat: {
          latest: '0.5.0',
          versions: {
            '0.4.0': {
              mavonengine: { engine: '>=0.0.22' },
            },
            '0.5.0': {
              mavonengine: { engine: '>=0.0.30' },
            },
          },
        },
      }),
    })

    expect(find(report, 'chat')).toEqual([
      expect.objectContaining({ level: 'info', fix: 'mavonengine install chat@0.4.0' }),
    ])
  })

  it('points out a plugin that is installed but not loaded', async () => {
    project()
    write('package.json', {
      name: 'game',
      scripts: { dev: 'x' },
      dependencies: { '@mavonengine/core': '0.0.25', 'forest': '^1' },
    })
    plugin('forest', '1.0.0', {})

    const report = await runDoctor(root, { ...options, offline: true }, { nodeVersion: '24.4.0' })

    expect(find(report, 'forest')).toEqual([
      expect.objectContaining({ level: 'info', fix: 'mavonengine install forest' }),
    ])
  })

  it('carries on without the registry, and says so once', async () => {
    project({
      config: {
        plugins: { a: {} },
      },
    })
    plugin('a', '1.0.0', { engine: '>=0.0.30' })
    const fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })

    const report = await runDoctor(root, options, { nodeVersion: '24.4.0', fetch })

    expect(find(report, 'npm registry')).toEqual([
      expect.objectContaining({
        level: 'warn',
        detail: expect.stringContaining('ENOTFOUND'),
      }),
    ])
    expect(find(report, 'a 1.0.0')[0]).toMatchObject({
      level: 'error',
      fix: expect.stringContaining('move @mavonengine/core into >=0.0.30'),
    })
  })

  it('fails on errors, and with --strict on warnings', async () => {
    project({
      config: { plugins: {}, appName: 7 },
    })
    let output = ''
    const io = {
      write: (text: string) => void (output += text),
      nodeVersion: '24.4.0',
    }
    const run = (strict: boolean, json = false) => runDoctorCommand({
      cwd: root,
      offline: true,
      strict,
      json,
      registry: '',
    }, io)

    expect(await run(false)).toBe(0)
    expect(output).toContain('0 errors, 1 warning')
    expect(await run(true)).toBe(1)

    output = ''
    await run(false, true)
    expect(JSON.parse(output)).toMatchObject({ root, errors: 0, warnings: 1 })

    await expect(runDoctorCommand({
      cwd: tmpdir(),
      offline: true,
      strict: false,
      json: false,
      registry: '',
    }, io)).rejects.toThrow(UsageError)
  })
})

describe('npm registry', () => {
  it('reads the full document of a package, once', async () => {
    const fetch = registry({
      x: {
        latest: '1.0.0',
        versions: {
          '1.0.0': {
            mavonengine: { engine: '*' },
          },
        },
      },
    })
    const npm = new NpmRegistry({ url: 'https://registry.example.com/', fetch })

    expect(await npm.get('x')).toEqual({
      name: 'x',
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          mavonengine: { engine: '*' },
        },
      },
    })
    await npm.get('x')
    expect(await npm.get('unknown')).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledWith('https://registry.example.com/x', expect.objectContaining({
      headers: { accept: 'application/json' },
    }))
    expect(npm.unreachable).toBeUndefined()
  })
})
