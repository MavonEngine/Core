/**
 * Stands in for `npm install file:<dir>` during the plugin e2e test: links the directory into
 * node_modules and records it in package.json, like npm does, without npm re-resolving the
 * project's other dependencies (which would replace the npm-linked @mavonengine/core).
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const [command, ...specs] = process.argv.slice(2)
if (command !== 'install' && command !== 'add') {
  process.stderr.write(`npm-stub: only 'install file:<dir>' is supported, got '${process.argv.slice(2).join(' ')}'\n`)
  process.exit(1)
}

const cwd = process.cwd()
const pkgPath = join(cwd, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dependencies ??= {}

for (const spec of specs) {
  if (!spec.startsWith('file:')) {
    process.stderr.write(`npm-stub: only file: specs are supported, got '${spec}'\n`)
    process.exit(1)
  }

  const dir = resolve(cwd, spec.slice('file:'.length))
  const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const link = join(cwd, 'node_modules', name)

  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  // Junctions need no admin rights on Windows
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  pkg.dependencies[name] = spec
  process.stdout.write(`npm-stub: linked ${name} -> ${dir}\n`)
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
