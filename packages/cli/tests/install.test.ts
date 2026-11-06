import type { InstallIO } from '../src/commands/install'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installArgs, installedNames, packageNameFromSpec, parseInstallArgs, runInstallCommand } from '../src/commands/install'

let dir: string

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const forest = {
  target: 'both',
  client: './client.js',
  server: './server.js',
  engine: '^0.0.22',
  assets: { prefabs: { Tree: ['tree.glb'], Rock: ['rock.glb'] } },
}

/**
 * An IO whose package manager "installs" by writing the given packages into node_modules and package.json.
 */
function fakeIO(packages: Record<string, object | undefined>, { interactive = true, answer = true } = {}) {
  let output = ''
  const io: InstallIO & { output(): string } = {
    run: vi.fn(async () => {
      const pkgPath = join(dir, 'package.json')
      const pkg = readJson(pkgPath)
      for (const [name, manifest] of Object.entries(packages)) {
        write(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.2.0', ...(manifest ? { mavonengine: manifest } : {}) }))
        pkg.dependencies[name] = '^1.2.0'
      }
      writeFileSync(pkgPath, JSON.stringify(pkg))
    }),
    confirm: vi.fn(async () => answer),
    interactive,
    write: (text) => {
      output += text
    },
    output: () => output,
  }
  return io
}

const configPath = () => join(dir, 'mavonengine.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-install-'))
  write(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@mavonengine/core': '0.0.22' }, scripts: { dev: 'x' } }))
  write(join(dir, 'node_modules', '@mavonengine', 'core', 'package.json'), JSON.stringify({ version: '0.0.22' }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseInstallArgs', () => {
  it('takes the packages and flags', () => {
    expect(parseInstallArgs(['forest', '@acme/hud@^2', '-y', '--cwd', 'game'], '/home')).toEqual({
      cwd: '/home/game',
      packages: ['forest', '@acme/hud@^2'],
      yes: true,
      register: true,
    })
  })

  it('turns registering off with --no-register', () => {
    expect(parseInstallArgs(['forest', '--no-register'], '/home')).toMatchObject({ register: false })
  })

  it('needs a package', () => {
    expect(() => parseInstallArgs([])).toThrow('which package?')
  })

  it('returns help', () => {
    expect(parseInstallArgs(['-h'])).toBe('help')
  })
})

describe('package names', () => {
  it.each([
    ['forest', 'forest'],
    ['forest@1.2.3', 'forest'],
    ['@acme/hud', '@acme/hud'],
    ['@acme/hud@^2', '@acme/hud'],
    ['github:acme/forest', undefined],
    ['https://example.com/forest.tgz', undefined],
    ['file:../missing', undefined],
  ])('%s → %s', (spec, name) => {
    expect(packageNameFromSpec(spec, dir)).toBe(name)
  })

  it.each([
    ['file:../forest-src', '..'],
    ['../forest-src', '..'],
    ['file:./forest-src', '.'],
  ])('reads the name of a local directory from %s', (spec, parent) => {
    const local = join(dir, parent, 'forest-src')
    write(join(local, 'package.json'), JSON.stringify({ name: '@acme/forest' }))

    expect(packageNameFromSpec(spec, dir)).toBe('@acme/forest')
    rmSync(local, { recursive: true, force: true })
  })

  it('finds what a git install added from package.json', () => {
    const before = new Map([['three', '1']])
    const after = new Map([['three', '1'], ['forest', 'file:../forest']])

    expect(installedNames(['github:acme/forest'], dir, before, after)).toEqual(['forest'])
  })

  it('uses the install command of each package manager', () => {
    expect(installArgs('npm', ['a'])).toEqual(['install', 'a'])
    expect(installArgs('pnpm', ['a'])).toEqual(['add', 'a'])
    expect(installArgs('yarn', ['a'])).toEqual(['add', 'a'])
    expect(installArgs('bun', ['a'])).toEqual(['add', 'a'])
  })
})

describe('runInstallCommand', () => {
  const options = (overrides = {}) => ({ cwd: dir, packages: ['forest'], yes: false, register: true, ...overrides })

  it('installs in the project root with its package manager', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    mkdirSync(join(dir, 'client'))
    const io = fakeIO({ forest })

    await runInstallCommand(options({ cwd: join(dir, 'client') }), io)

    expect(io.run).toHaveBeenCalledWith('pnpm', ['add', 'forest'], dir)
  })

  it('registers a plugin when the answer is yes and creates mavonengine.json', async () => {
    const io = fakeIO({ forest })

    expect(await runInstallCommand(options(), io)).toBe(0)

    expect(io.confirm).toHaveBeenCalledWith('Add forest to the plugins in mavonengine.json? (Y/n) ')
    expect(readJson(configPath())).toEqual({ plugins: { forest: { enabled: true } } })
    expect(io.output()).toContain('forest@1.2.0 is a MavonEngine plugin (client + server)')
    expect(io.output()).toContain('Prefabs: Tree, Rock')
    expect(io.output()).toContain('Made for @mavonengine/core ^0.0.22, you have 0.0.22')
    expect(io.output()).toContain('Restart the game server')
  })

  it('keeps the rest of an existing mavonengine.json', async () => {
    writeFileSync(configPath(), JSON.stringify({ custom: true, plugins: { other: { enabled: true } } }))

    await runInstallCommand(options(), fakeIO({ forest }))

    expect(readJson(configPath())).toEqual({ custom: true, plugins: { other: { enabled: true }, forest: { enabled: true } } })
  })

  it('leaves mavonengine.json alone when the answer is no', async () => {
    const io = fakeIO({ forest }, { answer: false })

    await runInstallCommand(options(), io)

    expect(existsSync(configPath())).toBe(false)
    expect(io.output()).toContain('Not added')
  })

  it('registers without asking with --yes, even without a terminal', async () => {
    const io = fakeIO({ forest }, { interactive: false })

    await runInstallCommand(options({ yes: true }), io)

    expect(io.confirm).not.toHaveBeenCalled()
    expect(readJson(configPath()).plugins.forest).toEqual({ enabled: true })
  })

  it('does not register without a terminal unless --yes is given', async () => {
    const io = fakeIO({ forest }, { interactive: false })

    await runInstallCommand(options(), io)

    expect(io.confirm).not.toHaveBeenCalled()
    expect(existsSync(configPath())).toBe(false)
    expect(io.output()).toContain('run with --yes')
  })

  it('only installs with --no-register', async () => {
    const io = fakeIO({ forest })

    await runInstallCommand(options({ register: false }), io)

    expect(io.confirm).not.toHaveBeenCalled()
    expect(existsSync(configPath())).toBe(false)
  })

  it('skips packages that are not plugins', async () => {
    const io = fakeIO({ lodash: undefined })

    expect(await runInstallCommand(options({ packages: ['lodash'] }), io)).toBe(0)

    expect(io.confirm).not.toHaveBeenCalled()
    expect(io.output()).toContain('lodash is installed. It is not a MavonEngine plugin')
  })

  it('does not ask again for a plugin that is already enabled', async () => {
    writeFileSync(configPath(), JSON.stringify({ plugins: { forest: { enabled: true, prefabs: ['Tree'] } } }))
    const io = fakeIO({ forest })

    await runInstallCommand(options(), io)

    expect(io.confirm).not.toHaveBeenCalled()
    expect(io.output()).toContain('Already in mavonengine.json')
    expect(readJson(configPath()).plugins.forest.prefabs).toEqual(['Tree'])
  })

  it('finds the plugin a path install added', async () => {
    const io = fakeIO({ forest })

    await runInstallCommand(options({ packages: ['file:../forest'], yes: true }), io)

    expect(readJson(configPath()).plugins.forest).toEqual({ enabled: true })
  })

  it('finds an already installed local plugin again from its directory', async () => {
    write(join(dir, 'forest-src', 'package.json'), JSON.stringify({ name: 'forest' }))
    const io = fakeIO({ forest })
    await runInstallCommand(options({ packages: ['file:./forest-src'], register: false }), io)

    // Installing the same path again changes nothing in package.json
    await runInstallCommand(options({ packages: ['file:./forest-src'], yes: true }), io)

    expect(readJson(configPath()).plugins.forest).toEqual({ enabled: true })
  })

  it('says so when it can\'t tell what was installed', async () => {
    const io = fakeIO({})

    await runInstallCommand(options({ packages: ['github:acme/forest'] }), io)

    expect(io.output()).toContain('couldn\'t tell which packages were installed')
  })

  it('reports an invalid plugin manifest and exits with 1', async () => {
    const io = fakeIO({ broken: { target: 'everywhere' } })

    expect(await runInstallCommand(options({ packages: ['broken'], yes: true }), io)).toBe(1)

    expect(io.output()).toContain('mavonengine.target')
    expect(existsSync(configPath())).toBe(false)
  })

  it('refuses to install when mavonengine.json is broken', async () => {
    writeFileSync(configPath(), '{ nope')
    const io = fakeIO({ forest })

    await expect(runInstallCommand(options(), io)).rejects.toThrow('not valid JSON')
    expect(io.run).not.toHaveBeenCalled()
  })

  it('needs a project', async () => {
    rmSync(join(dir, 'package.json'))

    await expect(runInstallCommand(options(), fakeIO({}))).rejects.toThrow('no MavonEngine project found')
  })
})
