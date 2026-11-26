import type { Migration } from '../../src/Migrations'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, MIGRATIONS, migrationsFor, pendingMigrations, ProjectFiles, recordedMigrations } from '../../src/Migrations'

let root: string

function write(path: string, content: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof content === 'string'
    ? content
    : `${JSON.stringify(content, null, 2)}\n`)
}

const read = (path: string) => readFileSync(join(root, path), 'utf8')
const readJson = (path: string) => JSON.parse(read(path))
function ctx(core = '0.0.25', cli = '0.0.6') {
  return {
    files: new ProjectFiles(root),
    versions: { core, cli },
  }
}

/** A project made from the template before core 0.0.22 */
function oldProject() {
  write('package.json', {
    name: 'my-game',
    scripts: { dev: 'npm run dev --prefix server', build: 'npm run build --workspaces' },
    dependencies: { '@mavonengine/core': '0.0.20' },
    devDependencies: { 'eslint': '^10.1.0', '@mavonengine/editor': '0.0.8' },
  })
  write('client/index.html', '<html>\n<head>\n  <title>Tom &amp; Jerry</title>\n</head>\n</html>\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mavonengine-migrations-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('project files', () => {
  it('keeps writes until they are committed', () => {
    write('a.json', '{\n    "x": 1\n}\n')
    const files = new ProjectFiles(root)

    files.writeJson('a.json', { x: 2 })
    files.write('new/b.txt', 'b')

    expect(files.read('a.json')).toBe('{\n    "x": 2\n}\n')
    expect(read('a.json')).toBe('{\n    "x": 1\n}\n')
    expect(files.changes().map(change => [change.path, change.before])).toEqual([
      ['a.json', '{\n    "x": 1\n}\n'],
      ['new/b.txt', undefined],
    ])

    files.commit()
    expect(read('a.json')).toBe('{\n    "x": 2\n}\n')
    expect(read('new/b.txt')).toBe('b')
    expect(files.changes()).toEqual([])
  })

  it('leaves out a write that changes nothing, and stays inside the project', () => {
    write('a.txt', 'a')
    const files = new ProjectFiles(root)

    files.write('a.txt', 'a')

    expect(files.changes()).toEqual([])
    expect(() => files.write('../outside.txt', 'x')).toThrow('outside the project')
  })
})

describe('migrations', () => {
  it('have unique ids that start with the core they need, oldest first', () => {
    const ids = MIGRATIONS.map(migration => migration.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const migration of MIGRATIONS)
      expect(migration.id.startsWith(`${migration.since}-`), migration.id).toBe(true)
    expect(migrationsFor('99.0.0').map(m => m.since)).toEqual(MIGRATIONS.map(m => m.since))
  })

  it('are only for the core that can have them', () => {
    expect(migrationsFor('0.0.21')).toEqual([])
    expect(migrationsFor('0.0.24').map(m => m.id)).toEqual(['0.0.22-dev-script'])
    expect(migrationsFor('0.0.25-beta.1').map(m => m.id)).toEqual(['0.0.22-dev-script', '0.0.25-app-name-title'])
    expect(migrationsFor('local')).toEqual([])
  })

  it('bring a project from before 0.0.22 up to the template', () => {
    oldProject()
    const migration = ctx()

    const pending = pendingMigrations(migration)
    expect(pending.map(m => m.id)).toEqual(['0.0.22-dev-script', '0.0.25-app-name-title'])

    const changes = applyMigrations(migration, pending)
    expect(changes.map(change => change.path)).toEqual(['package.json', 'client/index.html', 'mavonengine.json'])
    expect(read('package.json')).toContain('npm run dev --prefix server') // not written yet

    migration.files.commit()

    const pkg = readJson('package.json')
    expect(pkg.scripts).toEqual({ 'dev': 'mavonengine dev', 'dev:server': 'npm run dev --prefix server', 'build': 'npm run build --workspaces' })
    expect(Object.keys(pkg.scripts)).toEqual(['dev', 'dev:server', 'build'])
    expect(pkg.devDependencies).toEqual({ '@mavonengine/cli': '0.0.6', '@mavonengine/editor': '0.0.8', 'eslint': '^10.1.0' })
    expect(read('client/index.html')).toContain('<title>%MAVONENGINE_APP_NAME%</title>')
    expect(readJson('mavonengine.json')).toEqual({
      plugins: {},
      appName: 'Tom & Jerry',
      migrations: ['0.0.22-dev-script', '0.0.25-app-name-title'],
    })

    // Done: nothing is pending, and running again changes nothing
    expect(pendingMigrations(ctx())).toEqual([])
    expect(applyMigrations(ctx(), [])).toEqual([])
  })

  it('keep what a project already has', () => {
    write('package.json', {
      scripts: { 'dev': 'vite', 'dev:server': 'node server.js' },
      devDependencies: { '@mavonengine/cli': '^0.0.5' },
    })
    write('index.html', '<title>%MAVONENGINE_APP_NAME% – beta</title>')
    write('mavonengine.json', {
      plugins: { chat: {} },
    })

    expect(pendingMigrations(ctx())).toEqual([])
  })

  it('keep an appName the project has, and fill it from the title otherwise', () => {
    write('client/index.html', '<title>Old title</title>')
    write('mavonengine.json', { appName: 'Mine', plugins: {} })

    const migration = ctx()
    applyMigrations(migration, pendingMigrations(migration))
    migration.files.commit()

    expect(readJson('mavonengine.json').appName).toBe('Mine')
    expect(read('client/index.html')).toBe('<title>%MAVONENGINE_APP_NAME%</title>')
  })

  it('aren\'t offered again once recorded, even when undone', () => {
    oldProject()
    write('mavonengine.json', {
      plugins: {},
      migrations: ['0.0.25-app-name-title', 'from-a-newer-core'],
    })

    expect(pendingMigrations(ctx()).map(m => m.id)).toEqual(['0.0.22-dev-script'])

    const migration = ctx()
    applyMigrations(migration, pendingMigrations(migration))
    migration.files.commit()
    expect(recordedMigrations(new ProjectFiles(root))).toEqual(['0.0.25-app-name-title', 'from-a-newer-core', '0.0.22-dev-script'])
  })

  it('record the ones that didn\'t apply too', () => {
    write('package.json', {
      scripts: { 'dev': 'mavonengine dev', 'dev:server': 'x' },
    })
    const later: Migration = {
      id: '0.0.30-later',
      since: '0.0.30',
      description: '',
      applies: () => false,
      run: () => {},
    }

    const migration = ctx('0.0.30')
    applyMigrations(migration, [], [...MIGRATIONS, later])
    migration.files.commit()

    expect(readJson('mavonengine.json').migrations).toEqual(['0.0.22-dev-script', '0.0.25-app-name-title', '0.0.30-later'])
  })
})
