import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAG_URL } from '../src/config.ts'

import { createProject } from '../src/create.ts'
import { downloadZip } from '../src/downloader.ts'
import { runCommand } from '../src/runner.ts'

vi.mock('../src/downloader.ts', () => ({
  downloadZip: vi.fn(),
}))

vi.mock('../src/runner.ts', () => ({
  runCommand: vi.fn(),
}))

function createFakeZip(destPath: string): void {
  const zip = new AdmZip()
  zip.addFile('Core-0.0.6-alpha/', Buffer.alloc(0))
  zip.addFile('Core-0.0.6-alpha/packages/', Buffer.alloc(0))
  zip.addFile('Core-0.0.6-alpha/packages/multiplayer-template/', Buffer.alloc(0))
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/package.json',
    Buffer.from(
      JSON.stringify({ name: '@mavonengine/multiplayer-template', version: '0.0.1' }, null, 2),
    ),
  )
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/',
    Buffer.alloc(0),
  )
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/index.ts',
    Buffer.from('export {}'),
  )
  zip.writeZip(destPath)
}

function createFakeZipWithoutPackageJson(destPath: string): void {
  const zip = new AdmZip()
  zip.addFile('Core-0.0.6-alpha/', Buffer.alloc(0))
  zip.addFile('Core-0.0.6-alpha/packages/', Buffer.alloc(0))
  zip.addFile('Core-0.0.6-alpha/packages/multiplayer-template/', Buffer.alloc(0))
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/',
    Buffer.alloc(0),
  )
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/index.ts',
    Buffer.from('export {}'),
  )
  zip.writeZip(destPath)
}

describe('createProject', () => {
  let tmpDir: string
  let fakeZipPath: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mavon-create-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    fakeZipPath = join(tmpDir, 'fake.zip')
    createFakeZip(fakeZipPath)

    vi.mocked(downloadZip).mockResolvedValue(fakeZipPath)
    vi.mocked(runCommand).mockReturnValue(undefined)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('creates the project directory', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true })
    expect(existsSync(join(tmpDir, 'my-game'))).toBe(true)
  })

  it('extracts template files into project directory', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true })
    expect(existsSync(join(tmpDir, 'my-game', 'src', 'index.ts'))).toBe(true)
  })

  it('renames package.json name to the project name', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true })
    const pkg = JSON.parse(readFileSync(join(tmpDir, 'my-game', 'package.json'), 'utf-8'))
    expect(pkg.name).toBe('my-game')
  })

  it('runs npm install', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true })
    expect(runCommand).toHaveBeenCalledWith('npm', ['install'], join(tmpDir, 'my-game'))
  })

  it('runs npm run dev after install', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir })
    expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'dev'], join(tmpDir, 'my-game'))
  })

  it('skips npm install when skipInstall is true', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipInstall: true, skipDev: true })
    expect(runCommand).not.toHaveBeenCalledWith('npm', ['install'], expect.any(String))
  })

  it('still runs npm run dev when only skipInstall is true', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipInstall: true })
    expect(runCommand).not.toHaveBeenCalledWith('npm', ['install'], expect.any(String))
    expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'dev'], join(tmpDir, 'my-game'))
  })

  it('throws if project directory already exists', async () => {
    mkdirSync(join(tmpDir, 'existing-project'))
    await expect(
      createProject({ projectName: 'existing-project', targetDir: tmpDir, skipDev: true }),
    ).rejects.toThrow('already exists')
  })

  it('returns the absolute path to the created project', async () => {
    const dir = await createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true })
    expect(dir).toBe(join(tmpDir, 'my-game'))
  })

  it('downloads from the configured TAG_URL', async () => {
    await createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true })
    expect(downloadZip).toHaveBeenCalledWith(TAG_URL)
  })

  it('does not throw when template has no package.json', async () => {
    const zipWithoutPkg = join(tmpDir, 'no-pkg.zip')
    createFakeZipWithoutPackageJson(zipWithoutPkg)
    vi.mocked(downloadZip).mockResolvedValue(zipWithoutPkg)

    const dir = await createProject({ projectName: 'no-pkg-game', targetDir: tmpDir, skipDev: true })
    expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
  })

  it('propagates error when npm install fails', async () => {
    vi.mocked(runCommand).mockImplementation((cmd, args) => {
      if (cmd === 'npm' && args[0] === 'install') {
        throw new Error('npm install failed')
      }
    })

    await expect(
      createProject({ projectName: 'my-game', targetDir: tmpDir, skipDev: true }),
    ).rejects.toThrow('npm install failed')
  })

  it('propagates error when npm run dev fails', async () => {
    vi.mocked(runCommand).mockImplementation((cmd, args) => {
      if (cmd === 'npm' && args[0] === 'run') {
        throw new Error('dev server failed')
      }
    })

    await expect(
      createProject({ projectName: 'my-game', targetDir: tmpDir }),
    ).rejects.toThrow('dev server failed')
  })
})
