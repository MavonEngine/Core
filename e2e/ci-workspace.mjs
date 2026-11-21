/**
 * Carries the built workspace from CI's build job to the end-to-end jobs, with its links.
 *
 * npm's workspace links, the template's `npm link`s of core, cli and editor and (on Linux) the .bin entries are
 * symlinks, junctions on Windows. An archive doesn't carry those reliably on every OS, so `save` records them in
 * .ci-links.json and removes them before the workspace is archived, and `restore` puts them back after it is unpacked.
 * Both check that the template resolves core, cli and editor to this repository's packages, not to a copy.
 *
 *   node e2e/ci-workspace.mjs save
 *   node e2e/ci-workspace.mjs restore
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { isWindows, log, repo, template } from './helpers.mjs'

const manifest = join(repo, '.ci-links.json')
const linked = ['core', 'cli', 'editor']

function findLinks(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.name === '.git' && dir === repo)
      continue
    // Junctions show up as symbolic links too
    if (lstatSync(path).isSymbolicLink())
      found.push(path)
    else if (entry.isDirectory())
      findLinks(path, found)
  }
  return found
}

/** The template has to resolve core, cli and editor to packages/, the local build, not to an installed copy */
function checkTemplateLinks() {
  for (const name of linked) {
    const resolved = realpathSync(join(template, 'node_modules', '@mavonengine', name))
    const expected = realpathSync(join(repo, 'packages', name))
    if (resolved !== expected)
      throw new Error(`the template's @mavonengine/${name} is ${resolved}, not the local build in ${expected}`)
  }
  log(`the template uses the local build of ${linked.map(n => `@mavonengine/${n}`).join(', ')}`)
}

function save() {
  checkTemplateLinks()
  const links = findLinks(repo).map((path) => {
    let target
    let dir = false
    try {
      // Points at the real directory, also when npm linked through the global prefix, which the next job doesn't have
      const real = realpathSync(path)
      dir = statSync(real).isDirectory()
      target = real.startsWith(repo + sep) ? relative(dirname(path), real) : real
    }
    catch {
      target = readlinkSync(path)
    }
    return { path: relative(repo, path).split(sep).join('/'), target: target.split(sep).join('/'), dir }
  })
  writeFileSync(manifest, `${JSON.stringify(links, null, 2)}\n`)
  for (const { path } of links)
    rmSync(join(repo, path))
  log(`recorded and removed ${links.length} links`)
}

function restore() {
  const links = JSON.parse(readFileSync(manifest, 'utf8'))
  for (const { path, target, dir } of links) {
    const link = join(repo, path)
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { recursive: true, force: true })
    if (dir) {
      // Junctions need no admin rights on Windows, and take an absolute target
      symlinkSync(isWindows ? resolve(dirname(link), target) : target, link, isWindows ? 'junction' : 'dir')
      continue
    }
    try {
      symlinkSync(target, link, 'file')
    }
    catch (err) {
      // File symlinks need admin rights on Windows; a copy runs the same
      if (!isWindows)
        throw err
      copyFileSync(isAbsolute(target) ? target : resolve(dirname(link), target), link)
    }
  }
  log(`restored ${links.length} links`)
  checkTemplateLinks()
}

const command = process.argv[2]
if (command === 'save')
  save()
else if (command === 'restore')
  restore()
else
  throw new Error('usage: node e2e/ci-workspace.mjs save|restore')
