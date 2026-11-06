// Copy the .glsl and .css files from src into dist, which tsc leaves out.
// A Node script instead of find/cp so the build also runs on Windows.
import { cpSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const dist = join(root, 'dist')
const ASSET_RE = /\.(?:glsl|css)$/

let copied = 0
for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !ASSET_RE.test(entry.name))
    continue

  const from = join(entry.parentPath, entry.name)
  cpSync(from, join(dist, relative(src, from)))
  copied++
}

process.stdout.write(`Copied ${copied} .glsl / .css files into dist\n`)
