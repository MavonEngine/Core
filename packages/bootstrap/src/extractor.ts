import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface ExtractOptions {
  zipPath: string
  templateSubpath: string
  destDir: string
}

export function extractTemplate({ zipPath, templateSubpath, destDir }: ExtractOptions): void {
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()

  if (entries.length === 0) {
    throw new Error('Downloaded zip archive is empty')
  }

  const rootFolder = entries[0].entryName.split('/')[0]
  const templatePrefix = `${rootFolder}/${templateSubpath}/`

  const templateEntries = entries.filter(e => e.entryName.startsWith(templatePrefix))

  if (templateEntries.length === 0) {
    throw new Error(
      `Template path "${templateSubpath}" not found in zip archive (root: ${rootFolder})`,
    )
  }

  for (const entry of templateEntries) {
    const relativePath = entry.entryName.slice(templatePrefix.length)
    if (!relativePath) continue

    const outputPath = join(destDir, relativePath)

    if (entry.isDirectory) {
      mkdirSync(outputPath, { recursive: true })
    } else {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, entry.getData())
    }
  }
}
