import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { descendants, detectPackageManager, findProjectRoot, parseDevArgs, runDevCommand, startDev } from '../src/commands/dev'

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
    expect(parseDevArgs([], '/work')).toMatchObject({ cwd: '/work' })
  })

  it('resolves --cwd against the current directory', () => {
    expect(parseDevArgs(['--cwd', 'game'], '/work')).toMatchObject({ cwd: '/work/game' })
  })

  it('opens the browser unless --no-open is passed or the terminal is an SSH session', () => {
    expect(parseDevArgs([], '/work', {})).toMatchObject({ dashboard: { openBrowser: true, clientUrl: 'http://localhost:8050/' } })
    expect(parseDevArgs(['--no-open'], '/work', {})).toMatchObject({ dashboard: { openBrowser: false } })
    expect(parseDevArgs([], '/work', { SSH_TTY: '/dev/ttys001' })).toMatchObject({ dashboard: { openBrowser: false } })
  })

  it('shows the dashboard for the local server by default', () => {
    const options = parseDevArgs([], '/work', {})

    expect(options).toMatchObject({ dashboard: { intervalMs: 1000, transparent: false } })
    expect((options as any).dashboard.source.label).toBe('http://localhost:8050/api/game/metrics')
  })

  it('passes dashboard options on', () => {
    const options = parseDevArgs(['--port', '9000', '--theme', 'nord', '--transparent'], '/work', {})

    expect(options).toMatchObject({ dashboard: { theme: 'nord', transparent: true } })
    expect((options as any).dashboard.source.label).toBe('http://localhost:9000/api/game/metrics')
  })

  it('turns the dashboard off with --no-dashboard', () => {
    expect(parseDevArgs(['--no-dashboard'], '/work')).toEqual({ cwd: '/work', dashboard: false })
  })

  it('rejects a bad dashboard port', () => {
    expect(() => parseDevArgs(['--port', 'x'])).toThrow(/--port/)
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
    await expect(runDevCommand({ cwd: dir, dashboard: false })).rejects.toThrow(/no MavonEngine project found/)
  })

  it('runs the dev script and returns its exit code', async () => {
    writePackage(dir, { ...project, scripts: { dev: 'node -e "process.exit(3)"' } })

    expect(await runDevCommand({ cwd: dir, dashboard: false })).toBe(3)
  })
})

describe.skipIf(process.platform === 'win32')('startDev', () => {
  it('captures the output of the dev script', async () => {
    writePackage(dir, { ...project, scripts: { dev: 'node -e "console.log(\'hello from dev\')"' } })

    const dev = startDev(dir, { capture: true })

    expect(await dev.exited).toBe(0)
    expect(dev.output()).toContain('hello from dev')
  })

  it('stops the dev script and everything it started', async () => {
    // A grandchild that ignores SIGTERM, like a server that hangs on shutdown
    writeFileSync(join(dir, 'server.cjs'), `
      process.on('SIGTERM', () => {})
      require('node:fs').writeFileSync('server.pid', String(process.pid))
      setInterval(() => {}, 1000)
    `)
    writePackage(dir, { ...project, scripts: { dev: 'node server.cjs' } })

    const dev = startDev(dir, { capture: true })
    const pidFile = join(dir, 'server.pid')
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 })
    const serverPid = Number(readFileSync(pidFile, 'utf8'))

    await dev.stop()

    expect(() => process.kill(serverPid, 0)).toThrow()
  }, 15000)
})
