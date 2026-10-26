import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { descendants, detectPackageManager, findProjectRoot, parseDevArgs, runDevCommand } from '../src/commands/dev'

let dir: string

function writePackage(path: string, pkg: object) {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify(pkg))
}

const project = { dependencies: { '@mavonengine/core': '0.0.20' }, scripts: { dev: 'concurrently ...' } }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-dev-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('findProjectRoot', () => {
  it('finds the project in the start directory', () => {
    writePackage(dir, project)

    expect(findProjectRoot(dir)).toBe(dir)
  })

  it('walks up from a workspace to the project root', () => {
    writePackage(dir, project)
    writePackage(join(dir, 'client'), { scripts: { dev: 'vite' } })
    mkdirSync(join(dir, 'client', 'src'))

    expect(findProjectRoot(join(dir, 'client', 'src'))).toBe(dir)
  })

  it('accepts @mavonengine/core as a dev dependency', () => {
    writePackage(dir, { devDependencies: { '@mavonengine/core': '*' }, scripts: { dev: 'x' } })

    expect(findProjectRoot(dir)).toBe(dir)
  })

  it('skips packages without a dev script', () => {
    writePackage(dir, project)
    writePackage(join(dir, 'lib'), { dependencies: { '@mavonengine/core': '*' } })

    expect(findProjectRoot(join(dir, 'lib'))).toBe(dir)
  })

  it('ignores unreadable package.json files', () => {
    writePackage(dir, project)
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'package.json'), '{ nope')

    expect(findProjectRoot(join(dir, 'broken'))).toBe(dir)
  })

  it('returns undefined outside a project', () => {
    writePackage(dir, { scripts: { dev: 'vite' } })

    expect(findProjectRoot(dir)).toBeUndefined()
  })
})

describe('detectPackageManager', () => {
  it('defaults to npm', () => {
    expect(detectPackageManager(dir)).toBe('npm')
  })

  it.each([
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ])('picks the manager from %s', (lockfile, expected) => {
    writeFileSync(join(dir, lockfile), '')

    expect(detectPackageManager(dir)).toBe(expected)
  })
})

describe('descendants', () => {
  it('collects the whole tree below a process', () => {
    const ps = `
      1     0
     10     1
     11    10
     12    10
     13    11
     20     1
    `

    expect(descendants(10, ps).sort()).toEqual([11, 12, 13])
    expect(descendants(13, ps)).toEqual([])
  })
})

describe('parseDevArgs', () => {
  it('defaults to the current directory', () => {
    expect(parseDevArgs([], '/work')).toEqual({ cwd: '/work' })
  })

  it('resolves --cwd against the current directory', () => {
    expect(parseDevArgs(['--cwd', 'game'], '/work')).toEqual({ cwd: '/work/game' })
  })

  it('returns help', () => {
    expect(parseDevArgs(['-h'])).toBe('help')
  })

  it('rejects unknown flags', () => {
    expect(() => parseDevArgs(['--nope'])).toThrow()
  })
})

describe('runDevCommand', () => {
  it('fails with a usage error outside a project', async () => {
    await expect(runDevCommand({ cwd: dir })).rejects.toThrow(/no MavonEngine project found/)
  })

  it('runs the dev script and returns its exit code', async () => {
    writePackage(dir, { ...project, scripts: { dev: 'node -e "process.exit(3)"' } })

    expect(await runDevCommand({ cwd: dir })).toBe(3)
  })
})
