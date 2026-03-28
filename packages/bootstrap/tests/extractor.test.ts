import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { extractTemplate } from '../src/extractor.ts'

function createTestZip(destPath: string): void {
  const zip = new AdmZip()

  zip.addFile('Core-0.0.6-alpha/', Buffer.alloc(0))
  zip.addFile('Core-0.0.6-alpha/README.md', Buffer.from('# Core'))
  zip.addFile('Core-0.0.6-alpha/packages/', Buffer.alloc(0))
  zip.addFile('Core-0.0.6-alpha/packages/multiplayer-template/', Buffer.alloc(0))
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/package.json',
    Buffer.from(JSON.stringify({ name: '@mavonengine/multiplayer-template', version: '0.0.1' })),
  )
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/',
    Buffer.alloc(0),
  )
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/index.ts',
    Buffer.from('export {}'),
  )
  zip.addFile(
    'Core-0.0.6-alpha/packages/multiplayer-template/src/deeply/nested/util.ts',
    Buffer.from('export const x = 1'),
  )

  zip.writeZip(destPath)
}

describe('extractTemplate', () => {
  let tmpDir: string
  let zipPath: string
  let destDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mavon-extractor-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    zipPath = join(tmpDir, 'test.zip')
    destDir = join(tmpDir, 'output')
    mkdirSync(destDir, { recursive: true })
    createTestZip(zipPath)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('extracts only the template subpath contents into destDir', () => {
    extractTemplate({
      zipPath,
      templateSubpath: 'packages/multiplayer-template',
      destDir,
    })

    expect(existsSync(join(destDir, 'package.json'))).toBe(true)
    expect(existsSync(join(destDir, 'src', 'index.ts'))).toBe(true)
  })

  it('does not extract files outside the template path', () => {
    extractTemplate({
      zipPath,
      templateSubpath: 'packages/multiplayer-template',
      destDir,
    })

    expect(existsSync(join(destDir, 'README.md'))).toBe(false)
  })

  it('preserves file contents', () => {
    extractTemplate({
      zipPath,
      templateSubpath: 'packages/multiplayer-template',
      destDir,
    })

    const content = readFileSync(join(destDir, 'src', 'index.ts'), 'utf-8')
    expect(content).toBe('export {}')
  })

  it('creates deeply nested directories and files', () => {
    extractTemplate({
      zipPath,
      templateSubpath: 'packages/multiplayer-template',
      destDir,
    })

    const content = readFileSync(join(destDir, 'src', 'deeply', 'nested', 'util.ts'), 'utf-8')
    expect(content).toBe('export const x = 1')
  })

  it('throws when template subpath is not found in zip', () => {
    expect(() =>
      extractTemplate({
        zipPath,
        templateSubpath: 'packages/nonexistent',
        destDir,
      }),
    ).toThrow('not found in zip archive')
  })

  it('throws when zip is empty', () => {
    const emptyZip = new AdmZip()
    const emptyZipPath = join(tmpDir, 'empty.zip')
    emptyZip.writeZip(emptyZipPath)

    expect(() =>
      extractTemplate({
        zipPath: emptyZipPath,
        templateSubpath: 'packages/multiplayer-template',
        destDir,
      }),
    ).toThrow('empty')
  })
})
