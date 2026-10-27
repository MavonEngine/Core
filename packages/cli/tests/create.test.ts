import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatedSource, parseCreateArgs } from '../src/commands/create'
import { createProject, extractTemplate, TEMPLATE_SUBPATH } from '../src/create/project'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-create-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function templateZip(files: Record<string, string>) {
  const zip = new AdmZip()
  for (const [path, content] of Object.entries(files))
    zip.addFile(path, Buffer.from(content))
  return zip.toBuffer()
}

const template = {
  [`Core-0.0.14-alpha/${TEMPLATE_SUBPATH}/package.json`]: JSON.stringify({ name: '@mavonengine/multiplayer-template', scripts: { dev: 'x' } }),
  [`Core-0.0.14-alpha/${TEMPLATE_SUBPATH}/server/index.ts`]: 'export {}',
  'Core-0.0.14-alpha/packages/core/package.json': '{}',
}

function recorder() {
  const steps: string[] = []
  let output = ''
  return { steps, output: () => output, report: { step: (s: string) => steps.push(s), output: (c: string) => output += c } }
}

describe('parseCreateArgs', () => {
  it('takes the project name and the dev options', () => {
    const options = parseCreateArgs(['my-game', '--port', '9000', '--cwd', 'games'], '/home') as any

    expect(options.projectName).toBe('my-game')
    expect(options.cwd).toBe(resolve('/home/games'))
    expect(options.dashboard.source.label).toContain(':9000')
  })

  it('leaves the name to the prompt when missing', () => {
    expect((parseCreateArgs(['--no-dashboard'], '/home') as any).projectName).toBeUndefined()
  })

  it('rejects bad names and extra positionals', () => {
    expect(() => parseCreateArgs(['-bad'])).toThrow()
    expect(() => parseCreateArgs(['a', 'b'])).toThrow('one project name')
  })

  it('shows help', () => {
    expect(parseCreateArgs(['-h'])).toBe('help')
  })
})

describe('extractTemplate', () => {
  it('copies only the template folder', () => {
    const zipPath = join(dir, 't.zip')
    new AdmZip(templateZip(template)).writeZip(zipPath)

    expect(extractTemplate(zipPath, TEMPLATE_SUBPATH, join(dir, 'out'))).toBe(2)
    expect(existsSync(join(dir, 'out', 'server', 'index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'out', 'packages'))).toBe(false)
  })

  it('fails when the template is missing', () => {
    const zipPath = join(dir, 't.zip')
    new AdmZip(templateZip({ 'Core/README.md': '' })).writeZip(zipPath)

    expect(() => extractTemplate(zipPath, TEMPLATE_SUBPATH, join(dir, 'out'))).toThrow('not found')
  })
})

describe('createProject', () => {
  const fetchZip = (async () => new Response(templateZip(template))) as typeof fetch

  it('downloads, extracts and names the project, reporting each step', async () => {
    const { steps, output, report } = recorder()

    const projectDir = await createProject({ projectName: 'my-game', parentDir: dir, report, fetch: fetchZip, install: false })

    expect(projectDir).toBe(join(dir, 'my-game'))
    expect(JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).name).toBe('my-game')
    expect(steps[0]).toBe('Downloading the template…')
    expect(steps.some(s => s.includes(' B'))).toBe(true)
    expect(steps.at(-1)).toBe('Extracting the template…')
    expect(output()).toContain('Extracted 2 files')
  })

  it('refuses an existing directory', async () => {
    mkdirSync(join(dir, 'taken'))

    await expect(createProject({ projectName: 'taken', parentDir: dir, report: recorder().report, fetch: fetchZip, install: false }))
      .rejects
      .toThrow('already exists')
  })

  it('reports a failed download', async () => {
    const notFound = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch

    await expect(createProject({ projectName: 'x', parentDir: dir, report: recorder().report, fetch: notFound, install: false }))
      .rejects
      .toThrow('404 Not Found')
  })
})

describe('gatedSource', () => {
  it('keeps reporting connecting until ready', async () => {
    let ready = false
    const source = gatedSource({ label: 'http://localhost:8050', fetch: async () => ({ ok: true }) }, () => ready)

    await expect(source.fetch()).rejects.toMatchObject({ status: 'connecting' })
    ready = true
    await expect(source.fetch()).resolves.toEqual({ ok: true })
    expect(source.label).toBe('http://localhost:8050')
  })
})
