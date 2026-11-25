import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMakePluginArgs, runMakePluginCommand } from '../src/commands/make'
import { linkPlugin, pluginDirFor, pluginFiles } from '../src/make/plugin'
import { kebabName, pascalName, titleName, writeScaffold } from '../src/make/scaffold'

let dir: string

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

function io({ fail = false } = {}) {
  let output = ''
  const runs: string[] = []
  return {
    write: (text: string) => void (output += text),
    run: async (command: string, args: string[], cwd: string) => {
      runs.push(`${command} ${args.join(' ')} @ ${cwd}`)
      if (fail)
        throw new Error('\'npm install\' exited with code 1')
    },
    output: () => output,
    runs,
  }
}

function options(overrides = {}) {
  return {
    cwd: dir,
    name: 'forest',
    target: 'both' as const,
    register: true,
    install: true,
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-make-'))
  write(join(dir, 'package.json'), `${JSON.stringify({
    name: 'game',
    workspaces: ['client', 'server'],
    dependencies: { '@mavonengine/core': '0.0.25' },
    scripts: { dev: 'mavonengine dev' },
  }, null, 2)}\n`)
  write(join(dir, 'mavonengine.json'), '{ "plugins": {} }\n')
  write(join(dir, 'node_modules', '@mavonengine', 'core', 'package.json'), JSON.stringify({ name: '@mavonengine/core', version: '0.0.25' }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('names', () => {
  it('derives the names a generator needs', () => {
    expect(kebabName('@acme/Forest_Trees')).toBe('forest-trees')
    expect(titleName('@acme/forest-trees')).toBe('Forest Trees')
    expect(pascalName('forest.trees')).toBe('ForestTrees')
    expect(pluginDirFor('@acme/forest')).toBe('plugins/forest')
  })
})

describe('writeScaffold', () => {
  it('writes the files and never overwrites', () => {
    const target = join(dir, 'out')
    expect(writeScaffold(target, { 'a.txt': 'a', 'src/b.ts': 'b' })).toEqual(['a.txt', 'src/b.ts'])
    expect(readFileSync(join(target, 'src/b.ts'), 'utf8')).toBe('b')
    expect(() => writeScaffold(target, { 'c.txt': 'c' })).toThrow('already exists')
  })

  it('refuses paths outside the directory, before writing anything', () => {
    expect(() => writeScaffold(join(dir, 'out'), { 'ok.txt': '', '../escape.txt': '' })).toThrow('outside')
    expect(existsSync(join(dir, 'out'))).toBe(false)
  })
})

describe('pluginFiles', () => {
  it('only has the entries of its target', () => {
    const server = pluginFiles({ name: 'forest', target: 'server' })
    expect(Object.keys(server).sort()).toEqual([
      'README.md',
      'package.json',
      'src/server.ts',
      'tsconfig.json',
    ])
    expect(JSON.parse(server['package.json']).mavonengine).toEqual({ target: 'server', server: './src/server.ts' })

    const both = pluginFiles({ name: '@acme/forest', target: 'both', engine: '>=0.0.25' })
    expect(JSON.parse(both['package.json'])).toMatchObject({
      name: '@acme/forest',
      private: true,
      peerDependencies: { '@mavonengine/core': '>=0.0.25' },
      mavonengine: {
        target: 'both',
        client: './src/client.ts',
        server: './src/server.ts',
        engine: '>=0.0.25',
      },
    })
    expect(both['src/server.ts']).toContain('\'/api/forest/status\'')
    expect(both['src/client.ts']).toContain('name: "Forest"')
  })

  it('writes a server entry that loads through a workspace link', async () => {
    // Without @mavonengine/core installed here, swap its import for the same identity function
    const source = pluginFiles({ name: 'forest', target: 'server' })['src/server.ts']
      .replace(/^import .*$/m, 'const defineServerPlugin = <T>(plugin: T): T => plugin')
    const plugin = join(dir, 'plugins', 'forest')
    write(join(plugin, 'package.json'), '{ "type": "module" }')
    write(join(plugin, 'src', 'server.ts'), source)
    // Linked like a workspace: the import goes through node_modules
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    symlinkSync(plugin, join(dir, 'node_modules', 'forest'), 'dir')

    const exported = (await import(pathToFileURL(join(dir, 'node_modules', 'forest', 'src', 'server.ts')).href)).default
    expect(exported.name).toBe('Forest')
    expect(typeof exported.http).toBe('function')
  })
})

describe('linkPlugin', () => {
  it('adds plugins/* to the workspaces once, keeping the indentation', () => {
    expect(linkPlugin(dir, 'npm', 'forest', 'plugins/forest')).toBe('added "plugins/*" to workspaces')
    expect(readJson(join(dir, 'package.json')).workspaces).toEqual(['client', 'server', 'plugins/*'])
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('\n  "name"')
    expect(linkPlugin(dir, 'npm', 'rocks', 'plugins/rocks')).toBeUndefined()
  })

  it('starts workspaces, and keeps yarn\'s object form', () => {
    write(join(dir, 'package.json'), JSON.stringify({ name: 'game' }))
    linkPlugin(dir, 'npm', 'forest', 'plugins/forest')
    expect(readJson(join(dir, 'package.json')).workspaces).toEqual(['plugins/*'])

    write(join(dir, 'package.json'), JSON.stringify({
      workspaces: {
        packages: ['client'],
        nohoist: ['x'],
      },
    }))
    linkPlugin(dir, 'yarn', 'forest', 'plugins/forest')
    expect(readJson(join(dir, 'package.json')).workspaces).toEqual({
      packages: ['client', 'plugins/*'],
      nohoist: ['x'],
    })
  })

  it('gives pnpm a link: dependency', () => {
    expect(linkPlugin(dir, 'pnpm', '@acme/forest', 'plugins/forest')).toBe('added "@acme/forest": "link:./plugins/forest" to dependencies')
    expect(readJson(join(dir, 'package.json')).dependencies).toEqual({ '@mavonengine/core': '0.0.25', '@acme/forest': 'link:./plugins/forest' })
  })
})

describe('parseMakePluginArgs', () => {
  it('takes the name and flags', () => {
    expect(parseMakePluginArgs([
      '@acme/forest',
      '--target',
      'client',
      '--no-install',
      '--cwd',
      'game',
    ], '/home'))
      .toEqual({
        cwd: resolve('/home', 'game'),
        name: '@acme/forest',
        target: 'client',
        register: true,
        install: false,
      })
    expect(parseMakePluginArgs(['forest'], '/home')).toMatchObject({ target: 'both', register: true, install: true })
    expect(parseMakePluginArgs(['-h'])).toBe('help')
  })

  it('refuses bad input', () => {
    expect(() => parseMakePluginArgs([])).toThrow('name the plugin')
    expect(() => parseMakePluginArgs(['a', 'b'])).toThrow('one plugin name')
    expect(() => parseMakePluginArgs(['Forest'])).toThrow('not a package name')
    expect(() => parseMakePluginArgs(['../x'])).toThrow('not a package name')
    expect(() => parseMakePluginArgs(['forest', '--target', 'web'])).toThrow('--target')
  })
})

describe('mavonengine make:plugin', () => {
  it('writes, links, registers and installs the plugin, from anywhere inside the project', async () => {
    mkdirSync(join(dir, 'client', 'src'), { recursive: true })
    const out = io()

    expect(await runMakePluginCommand(options({
      cwd: join(dir, 'client', 'src'),
    }), out)).toBe(0)

    const plugin = join(dir, 'plugins', 'forest')
    expect(readJson(join(plugin, 'package.json')).mavonengine.engine).toBe('>=0.0.25')
    expect(existsSync(join(plugin, 'src', 'client.ts'))).toBe(true)
    expect(readJson(join(dir, 'package.json')).workspaces).toContain('plugins/*')
    expect(readJson(join(dir, 'mavonengine.json')).plugins).toEqual({
      forest: { enabled: true },
    })
    expect(out.runs).toEqual([`npm install @ ${dir}`])
    expect(out.output()).toContain('created forest in plugins/forest/')
  })

  it('leaves out the steps it is told to skip', async () => {
    const out = io()
    expect(await runMakePluginCommand(options({ register: false, install: false }), out)).toBe(0)

    expect(readJson(join(dir, 'mavonengine.json')).plugins).toEqual({})
    expect(out.runs).toEqual([])
    expect(out.output()).toContain('Next: run \'npm install\' to link it, then add "forest"')
  })

  it('reports a failed install, keeping what it wrote', async () => {
    const out = io({ fail: true })
    expect(await runMakePluginCommand(options(), out)).toBe(1)
    expect(existsSync(join(dir, 'plugins', 'forest', 'package.json'))).toBe(true)
    expect(out.output()).toContain('run \'npm install\' to link it')
  })

  it('refuses names that are taken, before writing anything', async () => {
    write(join(dir, 'node_modules', 'forest', 'package.json'), '{ "name": "forest" }')
    await expect(runMakePluginCommand(options(), io())).rejects.toThrow('already installed')

    write(join(dir, 'mavonengine.json'), '{ "plugins": { "rocks": { "enabled": true } } }')
    await expect(runMakePluginCommand(options({ name: 'rocks' }), io())).rejects.toThrow('already in mavonengine.json')

    mkdirSync(join(dir, 'plugins', 'trees'), { recursive: true })
    await expect(runMakePluginCommand(options({ name: '@acme/trees' }), io())).rejects.toThrow('already exists')
    expect(readJson(join(dir, 'package.json')).workspaces).toEqual(['client', 'server'])
  })

  it('needs a project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mavonengine-make-none-'))
    try {
      await expect(runMakePluginCommand(options({ cwd: outside }), io())).rejects.toThrow('no MavonEngine project')
    }
    finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
