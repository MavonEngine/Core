import type { UpgradeIO, UpgradeOptions } from '../src/commands/upgrade'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as cliVersion } from '../package.json'
import { UsageError } from '../src/commands/dashboard'
import { runDoctor } from '../src/commands/doctor'
import { parseUpgradeArgs, runUpgradeCommand } from '../src/commands/upgrade'
import { NpmRegistry } from '../src/doctor/npm'
import { lineDiff } from '../src/upgrade/diff'
import { loadMigrations } from '../src/upgrade/migrations'
import { installCommands, planUpgrade } from '../src/upgrade/plan'

let root: string

function write(path: string, content: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof content === 'string'
    ? content
    : `${JSON.stringify(content, null, 2)}\n`)
}

const read = (path: string) => readFileSync(join(root, path), 'utf8')
const readJson = (path: string) => JSON.parse(read(path))

function installed(name: string, version: string, extra: Record<string, unknown> = {}) {
  write(`node_modules/${name}/package.json`, { name, version, ...extra })
}

/** A project on core 0.0.25 with the template's packages and a plugin */
function project(pkg: Record<string, unknown> = {}) {
  write('package.json', {
    name: 'game',
    scripts: { 'dev': 'mavonengine dev', 'dev:server': 'npm run dev --prefix server' },
    dependencies: { '@mavonengine/core': '0.0.25', '@mavonengine/chat': '^0.1.0' },
    devDependencies: { '@mavonengine/cli': '0.0.6', 'eslint': '^10' },
    ...pkg,
  })
  installed('@mavonengine/core', '0.0.25')
  installed('@mavonengine/cli', '0.0.6')
  installed('@mavonengine/chat', '0.1.0', {
    mavonengine: { target: 'server', server: 'server.js', engine: '>=0.0.22' },
  })
  write('node_modules/@mavonengine/chat/server.js', '')
  write('mavonengine.json', {
    plugins: { '@mavonengine/chat': {} },
  })
}

function engine(range: string) {
  return {
    mavonengine: { target: 'server', engine: range },
  }
}

const REGISTRY = {
  '@mavonengine/core': {
    latest: '0.0.27',
    versions: {
      '0.0.25': {},
      '0.0.26': {},
      '0.0.27': {},
      '0.0.28-beta': {},
    },
  },
  '@mavonengine/cli': {
    latest: '0.0.8',
    versions: { '0.0.6': {}, '0.0.8': {} },
  },
  '@mavonengine/chat': {
    latest: '0.3.0',
    versions: {
      '0.1.0': engine('>=0.0.22'),
      '0.2.0': engine('>=0.0.26'),
      '0.3.0': engine('>=0.0.28'),
    },
  },
} as Record<string, { latest: string, versions: Record<string, Record<string, unknown>> }>

function registry(packages = REGISTRY) {
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

function npm(packages = REGISTRY) {
  return new NpmRegistry({
    url: 'https://registry.example.com',
    fetch: registry(packages),
  })
}

function options(extra: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    cwd: root,
    onlyMigrations: false,
    dryRun: false,
    yes: true,
    force: false,
    allowDirty: false,
    registry: 'https://registry.example.com',
    ...extra,
  }
}

function io(extra: Partial<UpgradeIO> = {}) {
  let output = ''
  const runs: string[] = []
  const value: UpgradeIO = {
    run: vi.fn(async (command: string, args: string[]) => void runs.push(`${command} ${args.join(' ')}`)),
    confirm: vi.fn(async () => true),
    interactive: true,
    write: (text: string) => void (output += text),
    gitStatus: () => '',
    fetch: registry(),
    ...extra,
  }
  return {
    io: value,
    runs,
    output: () => output,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mavonengine-upgrade-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the upgrade plan', () => {
  it('moves core to its latest, and each package to its newest version that takes it', async () => {
    project()

    const plan = await planUpgrade(root, readJson('package.json'), npm())

    expect(plan.core).toEqual({ from: '0.0.25', to: '0.0.27' })
    expect(plan.bumps.map(b => [
      b.name,
      b.installed,
      b.to,
      b.exact,
      b.field,
    ])).toEqual([
      [
        '@mavonengine/core',
        '0.0.25',
        '0.0.27',
        true,
        'dependencies',
      ],
      // 0.3.0 needs core 0.0.28
      [
        '@mavonengine/chat',
        '0.1.0',
        '0.2.0',
        false,
        'dependencies',
      ],
      [
        '@mavonengine/cli',
        '0.0.6',
        '0.0.8',
        true,
        'devDependencies',
      ],
    ])
  })

  it('takes the core to move to, and refuses one that isn\'t published', async () => {
    project()

    const plan = await planUpgrade(root, readJson('package.json'), npm(), '0.0.26')
    expect(plan.bumps.find(b => b.name === '@mavonengine/chat')?.to).toBe('0.2.0')

    await expect(planUpgrade(root, readJson('package.json'), npm(), '0.0.99')).rejects.toThrow('isn\'t published')
  })

  it('blocks on a plugin with no version for the new core', async () => {
    project()

    const plan = await planUpgrade(root, readJson('package.json'), npm({
      ...REGISTRY,
      '@mavonengine/chat': {
        latest: '0.1.0',
        versions: {
          '0.1.0': engine('<0.0.26'),
        },
      },
    }))

    expect(plan.bumps.find(b => b.name === '@mavonengine/chat')).toMatchObject({ blocked: true, note: 'no published version supports @mavonengine/core 0.0.27' })
  })

  it('leaves alone what isn\'t from the registry, and never goes down', async () => {
    project({
      dependencies: { '@mavonengine/core': '0.0.25', '@mavonengine/chat': 'file:../chat' },
      devDependencies: { '@mavonengine/cli': '0.0.9', '@mavonengine/private': '1.0.0' },
    })
    installed('@mavonengine/cli', '0.0.9')

    const plan = await planUpgrade(root, readJson('package.json'), npm())

    expect(plan.bumps.map(b => [b.name, b.to, b.note])).toEqual([
      ['@mavonengine/core', '0.0.27', undefined],
      ['@mavonengine/chat', undefined, 'stays: file:../chat isn\'t from the registry'],
      ['@mavonengine/cli', undefined, undefined],
      ['@mavonengine/private', undefined, 'stays: not on the registry'],
    ])
  })

  it('installs each package where package.json has it, pinned when it is pinned', () => {
    const bump = (name: string, to: string | undefined, field: 'dependencies' | 'devDependencies', exact: boolean) => ({
      name,
      to,
      field,
      exact,
      spec: '',
      plugin: false,
    })
    const bumps = [
      bump('a', '1.0.0', 'dependencies', true),
      bump('b', '2.0.0', 'dependencies', false),
      bump('c', '3.0.0', 'devDependencies', true),
      bump('d', undefined, 'dependencies', true),
    ]

    expect(installCommands('npm', bumps)).toEqual([
      ['install', 'a@1.0.0', '--save-exact'],
      ['install', 'b@2.0.0'],
      [
        'install',
        'c@3.0.0',
        '--save-dev',
        '--save-exact',
      ],
    ])
    expect(installCommands('yarn', bumps)[2]).toEqual(['add', 'c@3.0.0', '--dev', '--exact'])
  })
})

describe('the diff', () => {
  it('shows removed lines before added ones, with a little context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h'].join('\n')

    expect(lineDiff(before, after)).toEqual([
      '  …',
      '  c',
      '  d',
      '- e',
      '+ E',
      '  f',
      '  g',
      '  …',
    ])
    expect(lineDiff(undefined, 'x\ny\n')).toEqual(['+ x', '+ y'])
  })
})

describe('the migrations it runs', () => {
  it('come from the project\'s core when it has them, else from the CLI', async () => {
    project()
    expect((await loadMigrations(root)).from).toBe('cli')

    write('node_modules/@mavonengine/core/dist/Migrations/index.js', `
      export const MIGRATIONS_API = 1
      export const MIGRATIONS = [{ id: 'from-the-project' }]
    `)
    const { module, from } = await loadMigrations(root)
    expect(from).toBe('project')
    expect(module.MIGRATIONS.map(m => m.id)).toEqual(['from-the-project'])

    // A core with a newer API, in another project: Node keeps the module it imported for a path
    write('newer/node_modules/@mavonengine/core/package.json', { name: '@mavonengine/core', version: '1.0.0' })
    write('newer/node_modules/@mavonengine/core/dist/Migrations/index.js', 'export const MIGRATIONS_API = 2; export const MIGRATIONS = []')
    expect((await loadMigrations(join(root, 'newer'))).from).toBe('cli')
  })
})

describe('mavonengine upgrade', () => {
  it('takes its options', () => {
    expect(parseUpgradeArgs([], root, {})).toEqual({
      cwd: root,
      to: undefined,
      onlyMigrations: false,
      dryRun: false,
      yes: false,
      force: false,
      allowDirty: false,
      registry: 'https://registry.npmjs.org',
    })
    expect(parseUpgradeArgs([
      '--to',
      '0.0.26',
      '-y',
      '--dry-run',
      '--force',
      '--allow-dirty',
    ], root, { npm_config_registry: 'https://npm.example.com' }))
      .toMatchObject({
        to: '0.0.26',
        yes: true,
        dryRun: true,
        force: true,
        allowDirty: true,
        registry: 'https://npm.example.com',
      })
    expect(parseUpgradeArgs(['--only-migrations'], root, {})).toMatchObject({ onlyMigrations: true })
    expect(() => parseUpgradeArgs(['--to', 'latest'])).toThrow(UsageError)
    expect(() => parseUpgradeArgs(['--to', '0.0.26', '--only-migrations'])).toThrow(UsageError)
    expect(() => parseUpgradeArgs(['now'])).toThrow(UsageError)
  })

  it('installs the new versions, then checks the project', async () => {
    project()
    const { io: upgradeIO, runs, output } = io()

    const code = await runUpgradeCommand(options(), upgradeIO)

    expect(runs).toEqual([
      'npm install @mavonengine/core@0.0.27 --save-exact',
      'npm install @mavonengine/chat@0.2.0',
      'npm install @mavonengine/cli@0.0.8 --save-dev --save-exact',
    ])
    expect(output()).toContain('↑ @mavonengine/core  0.0.25  → 0.0.27')
    expect(output()).toContain('mavonengine doctor')
    // The fake install changed nothing, so doctor sees core 0.0.25 and the newer versions it could have
    expect(code).toBe(0)
  })

  it('refuses to start with uncommitted changes', async () => {
    project()
    const { io: upgradeIO, runs, output } = io({
      gitStatus: () => ' M src/game.ts\n',
    })

    expect(await runUpgradeCommand(options(), upgradeIO)).toBe(1)
    expect(output()).toContain('M src/game.ts')
    expect(runs).toEqual([])

    expect(await runUpgradeCommand(options({ allowDirty: true }), io({
      gitStatus: () => ' M x',
    }).io)).toBe(0)
  })

  it('stops when a plugin would stop working, unless forced', async () => {
    project()
    const fetch = registry({
      ...REGISTRY,
      '@mavonengine/chat': {
        latest: '0.1.0',
        versions: {
          '0.1.0': engine('<0.0.26'),
        },
      },
    })

    const blocked = io({ fetch })
    expect(await runUpgradeCommand(options(), blocked.io)).toBe(1)
    expect(blocked.output()).toContain('@mavonengine/chat would stop working')
    expect(blocked.runs).toEqual([])

    const forced = io({ fetch })
    await runUpgradeCommand(options({ force: true }), forced.io)
    expect(forced.runs).toEqual(['npm install @mavonengine/core@0.0.27 --save-exact', 'npm install @mavonengine/cli@0.0.8 --save-dev --save-exact'])
  })

  it('shows the migrations, writes them when told to, and installs what they add', async () => {
    project({
      scripts: { dev: 'npm run dev --prefix server' },
      devDependencies: {},
    })
    // What `npm install` leaves for the @mavonengine/cli the migration adds, which the fake install doesn't
    installed('@mavonengine/cli', cliVersion)
    write('client/index.html', '<title>My Game</title>\n')
    const { io: upgradeIO, runs, output } = io()

    const code = await runUpgradeCommand(options({ onlyMigrations: true }), upgradeIO)

    expect(output()).toContain('0.0.22-dev-script')
    expect(output()).toContain('-     "dev": "npm run dev --prefix server"')
    expect(output()).toContain('+ <title>%MAVONENGINE_APP_NAME%</title>')
    expect(readJson('package.json').scripts).toEqual({ 'dev': 'mavonengine dev', 'dev:server': 'npm run dev --prefix server' })
    expect(readJson('package.json').devDependencies).toEqual({ '@mavonengine/cli': cliVersion })
    expect(readJson('mavonengine.json')).toMatchObject({
      appName: 'My Game',
      migrations: ['0.0.22-dev-script', '0.0.25-app-name-title'],
    })
    // The migration added @mavonengine/cli
    expect(runs).toEqual(['npm install'])
    expect(code).toBe(0)

    // Done: doctor has nothing pending, and running again changes nothing
    const report = await runDoctor(root, { offline: true, registry: '' })
    expect(report.findings.filter(f => f.group === 'Migrations')).toEqual([
      expect.objectContaining({ level: 'ok', label: 'none pending' }),
    ])
    const again = io()
    await runUpgradeCommand(options({ onlyMigrations: true }), again.io)
    expect(again.output()).toContain('none pending')
    expect(again.runs).toEqual([])
  })

  it('changes nothing on a dry run', async () => {
    project({
      scripts: { dev: 'npm run dev --prefix server' },
    })
    const before = read('package.json')
    const { io: upgradeIO, runs, output } = io({
      gitStatus: () => ' M dirty',
    })

    expect(await runUpgradeCommand(options({ dryRun: true, yes: false }), upgradeIO)).toBe(0)

    expect(output()).toContain('Would run:\n  npm install @mavonengine/core@0.0.27 --save-exact')
    expect(output()).toContain('Nothing written (--dry-run)')
    expect(read('package.json')).toBe(before)
    expect(existsSync(join(root, 'mavonengine.json'))).toBe(true)
    expect(readJson('mavonengine.json').migrations).toBeUndefined()
    expect(runs).toEqual([])
  })

  it('asks first, and without a terminal needs --yes', async () => {
    project({
      scripts: { dev: 'npm run dev --prefix server' },
    })

    const declined = io({
      confirm: vi.fn(async () => false),
    })
    expect(await runUpgradeCommand(options({ yes: false, onlyMigrations: true }), declined.io)).toBe(1)
    expect(declined.io.confirm).toHaveBeenCalledWith(expect.stringContaining('Write these 2 changes?'))
    expect(readJson('package.json').scripts.dev).toBe('npm run dev --prefix server')

    const noTerminal = io({ interactive: false })
    expect(await runUpgradeCommand(options({ yes: false }), noTerminal.io)).toBe(1)
    expect(noTerminal.output()).toContain('run with --yes to install')
    expect(noTerminal.runs).toEqual([])
  })

  it('says so when the registry can\'t be reached', async () => {
    project()
    const { io: upgradeIO, output } = io({
      fetch: vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }),
    })

    expect(await runUpgradeCommand(options(), upgradeIO)).toBe(1)
    expect(output()).toContain('Can\'t plan the upgrade: can\'t reach https://registry.example.com')
  })
})
