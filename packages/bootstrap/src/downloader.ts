import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function downloadZip(url: string): Promise<string> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  const dest = join(tmpdir(), `mavonengine-bootstrap-${Date.now()}.zip`)
  const fileStream = createWriteStream(dest)

  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), fileStream)

  return dest
}

export function extractZipRootFolder(zipEntries: string[]): string {
  const first = zipEntries.find(e => e.includes('/'))
  if (!first)
    throw new Error('Could not determine root folder in zip archive')
  return first.split('/')[0]
}
