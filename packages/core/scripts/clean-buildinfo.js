// Remove tsc's incremental build info so a build always emits everything. Works on Windows, unlike rm -f.
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

rmSync(resolve(dirname(fileURLToPath(import.meta.url)), '../tsconfig.build.tsbuildinfo'), { force: true })
