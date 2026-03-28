import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { TAG_URL, TEMPLATE_SUBPATH } from './config.js'
import { downloadZip } from './downloader.js'
import { extractTemplate } from './extractor.js'
import { runCommand } from './runner.js'

export interface CreateOptions {
  projectName: string
  targetDir?: string
  skipInstall?: boolean
  skipDev?: boolean
}

export async function createProject({
  projectName,
  targetDir,
  skipInstall = false,
  skipDev = false,
}: CreateOptions): Promise<string> {
  const projectDir = resolve(targetDir ?? process.cwd(), projectName)

  if (existsSync(projectDir)) {
    throw new Error(`Directory "${projectDir}" already exists`)
  }

  console.log(`\nCreating project "${projectName}"...`)
  mkdirSync(projectDir, { recursive: true })

  console.log(`Downloading template from ${TAG_URL}...`)
  const zipPath = await downloadZip(TAG_URL)

  console.log('Extracting template...')
  extractTemplate({ zipPath, templateSubpath: TEMPLATE_SUBPATH, destDir: projectDir })

  const pkgJsonPath = join(projectDir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    pkg.name = projectName
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  }

  if (!skipInstall) {
    console.log('Installing dependencies...')
    runCommand('npm', ['install'], projectDir)
  }

  if (!skipDev) {
    console.log('Starting dev server...')
    runCommand('npm', ['run', 'dev'], projectDir)
  }

  return projectDir
}
