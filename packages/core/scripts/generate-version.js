import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'))

writeFileSync(
  resolve(__dirname, '../src/version.ts'),
  `export const version = '${version}'\n`,
)
