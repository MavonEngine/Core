import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import AdmZip from 'adm-zip'
import { formatBytes } from '../dashboard/format'

export const TEMPLATE_URL = 'https://github.com/MavonEngine/Core/archive/refs/tags/0.0.14-alpha.zip'
export const TEMPLATE_SUBPATH = 'packages/multiplayer-template'

export const PROJECT_NAME_RE = /^[\w@./-][\w@./\- ]*$/

/**
 * Where creating a project reports to: the startup screen, or the terminal without a dashboard.
 */
export interface CreateReporter {
  /** What is happening right now, one line */
  step(label: string): void
  /** Output of the commands that run, as it arrives */
  output(chunk: string): void
}

export interface CreateProjectOptions {
  projectName: string
  /** The project is created in a new directory named after it in here */
  parentDir: string
  report: CreateReporter
  /** Stops the download or the install */
  signal?: AbortSignal
  templateUrl?: string
  fetch?: typeof globalThis.fetch
  /** Install the dependencies, default true */
  install?: boolean
}

export function projectDirFor(projectName: string, parentDir: string) {
  return resolve(parentDir, projectName)
}

/**
 * Download `url` to a temporary file, reporting the bytes received.
 */
export async function downloadZip(url: string, { report, signal, fetch = globalThis.fetch }: Pick<CreateProjectOptions, 'report' | 'signal' | 'fetch'>): Promise<string> {
  const response = await fetch(url, { signal })

  if (!response.ok || !response.body)
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)

  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const progress = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      received += chunk.length
      report.step(`Downloading the template… ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}`)
      callback(null, chunk)
    },
  })

  const dest = join(tmpdir(), `mavonengine-create-${process.pid}-${Date.now()}.zip`)
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), progress, createWriteStream(dest), { signal })
  }
  catch (err) {
    rmSync(dest, { force: true })
    throw err
  }

  return dest
}

/**
 * Copy `templateSubpath` out of a GitHub archive (everything is under one root folder) into `destDir`.
 * Returns the number of files written.
 */
export function extractTemplate(zipPath: string, templateSubpath: string, destDir: string): number {
  const entries = new AdmZip(zipPath).getEntries()

  if (entries.length === 0)
    throw new Error('Downloaded zip archive is empty')

  const rootFolder = entries[0].entryName.split('/')[0]
  const templatePrefix = `${rootFolder}/${templateSubpath}/`
  const templateEntries = entries.filter(e => e.entryName.startsWith(templatePrefix))

  if (templateEntries.length === 0)
    throw new Error(`Template path "${templateSubpath}" not found in zip archive (root: ${rootFolder})`)

  const root = resolve(destDir)
  let files = 0
  for (const entry of templateEntries) {
    const relativePath = entry.entryName.slice(templatePrefix.length)
    if (!relativePath)
      continue

    const outputPath = resolve(root, relativePath)
    // A crafted archive could point outside the project with ../
    const inside = relative(root, outputPath)
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new Error(`Refusing to extract ${entry.entryName} outside the project`)

    if (entry.isDirectory) {
      mkdirSync(outputPath, { recursive: true })
    }
    else {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, entry.getData())
      files++
    }
  }

  return files
}

/**
 * Run a command with its output going to the reporter. Rejects on a non-zero exit.
 */
export function runCommand(command: string, args: string[], cwd: string, { report, signal }: Pick<CreateProjectOptions, 'report' | 'signal'>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm is a .cmd shim on Windows
      shell: process.platform === 'win32',
      signal,
    })

    child.stdout.setEncoding('utf8').on('data', report.output)
    child.stderr.setEncoding('utf8').on('data', report.output)

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new Error(`'${command}' was not found on your PATH`) : err)
    })

    child.on('exit', (code, exitSignal) => {
      if (code === 0)
        resolvePromise()
      else
        reject(new Error(`'${command} ${args.join(' ')}' ${code === null ? `was stopped by ${exitSignal}` : `exited with code ${code}`}`))
    })
  })
}

/**
 * Create a project from the multiplayer template: download, extract, name it and install its dependencies.
 * Resolves with the project directory.
 */
export async function createProject({ projectName, parentDir, report, signal, templateUrl = TEMPLATE_URL, fetch, install = true }: CreateProjectOptions): Promise<string> {
  const projectDir = projectDirFor(projectName, parentDir)

  if (existsSync(projectDir))
    throw new Error(`Directory "${projectDir}" already exists`)

  report.output(`Creating project "${projectName}" in ${projectDir}\n`)
  mkdirSync(projectDir, { recursive: true })

  report.step('Downloading the template…')
  report.output(`Downloading the template from ${templateUrl}\n`)
  const zipPath = await downloadZip(templateUrl, { report, signal, fetch })

  try {
    report.step('Extracting the template…')
    const files = extractTemplate(zipPath, TEMPLATE_SUBPATH, projectDir)
    report.output(`Extracted ${files} files\n`)
  }
  finally {
    rmSync(zipPath, { force: true })
  }

  const pkgJsonPath = join(projectDir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    pkg.name = projectName
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }

  if (install) {
    signal?.throwIfAborted()
    report.step('Installing dependencies…')
    report.output('Running \'npm install\'\n')
    await runCommand('npm', ['install'], projectDir, { report, signal })
  }

  return projectDir
}
