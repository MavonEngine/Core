/**
 * CI check for pull requests: when the multiplayer template's project files change in a way existing projects would
 * have to follow, the pull request needs a new `mavonengine upgrade` migration (packages/core/src/Migrations/
 * migrations.ts) or `[no migration]` in its description.
 *
 * What counts: the template's package.json files (scripts, workspaces, which dependencies, but not their versions,
 * which every release bumps), its config files and index.html. Not its game code, README or lockfile.
 *
 *   node scripts/check-migrations.mjs <base> [head]
 *
 * MIGRATION_CHECK_SKIP=true passes it (the workflow sets that for `[no migration]`).
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const TEMPLATE = 'packages/multiplayer-template/'
const MIGRATIONS = 'packages/core/src/Migrations/migrations.ts'

/** Project files a migration may have to change, relative to the template */
const WATCHED = [
  'package.json',
  'client/package.json',
  'server/package.json',
  'mavonengine.json',
  'client/index.html',
  'client/vite.config.js',
  'client/vite.config.ts',
  'tsconfig.json',
  'client/tsconfig.json',
  'server/tsconfig.json',
  'server/tsup.config.ts',
  'eslint.config.mjs',
]

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const ADDED_ID_RE = /^\+\s*id:\s*['"`]/m
const WHITESPACE_RE = /\s+/g

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

function show(ref, path) {
  try {
    return git('show', `${ref}:${path}`)
  }
  catch {
    return undefined
  }
}

/**
 * What of a package.json a project would have to follow: everything but its own version, the versions of its
 * dependencies and npm's overrides.
 */
function normalizePackageJson(text) {
  const pkg = JSON.parse(text)
  delete pkg.version
  delete pkg.overrides
  for (const field of DEPENDENCY_FIELDS) {
    if (pkg[field])
      pkg[field] = Object.keys(pkg[field]).sort()
  }
  return pkg
}

/** The parts of a file that changed in a way that matters, or an empty list */
function differences(path, before, after) {
  if (before === undefined)
    return ['added']
  if (after === undefined)
    return ['removed']

  if (path.endsWith('package.json')) {
    const a = normalizePackageJson(before)
    const b = normalizePackageJson(after)
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      .map(key => DEPENDENCY_FIELDS.includes(key) ? `${key} added or removed a package` : `"${key}" changed`)
  }

  // Whitespace alone isn't something a project has to follow
  return before.replace(WHITESPACE_RE, ' ').trim() === after.replace(WHITESPACE_RE, ' ').trim() ? [] : ['changed']
}

function main() {
  const [base, head = 'HEAD'] = process.argv.slice(2)
  if (!base) {
    process.stderr.write('usage: node scripts/check-migrations.mjs <base> [head]\n')
    process.exit(2)
  }

  // What the pull request changes: from where it branched off, like GitHub's diff
  const from = git('merge-base', base, head).trim()
  const changed = git('diff', '--name-only', from, head).split('\n').filter(Boolean)

  const found = changed
    .filter(path => path.startsWith(TEMPLATE) && WATCHED.includes(path.slice(TEMPLATE.length)))
    .map(path => ({ path, what: differences(path, show(from, path), show(head, path)) }))
    .filter(({ what }) => what.length)

  if (!found.length) {
    process.stdout.write('check-migrations: no template project file changes that need a migration\n')
    return
  }

  const report = found.map(({ path, what }) => `  ${path.slice(TEMPLATE.length)}: ${what.join(', ')}`).join('\n')

  if (ADDED_ID_RE.test(git('diff', from, head, '--', MIGRATIONS))) {
    process.stdout.write(`check-migrations: the template's project files changed, and a migration was added:\n${report}\n`)
    return
  }

  if (process.env.MIGRATION_CHECK_SKIP === 'true') {
    process.stdout.write(`check-migrations: the template's project files changed, the pull request says [no migration]:\n${report}\n`)
    return
  }

  process.stderr.write(`check-migrations: the template's project files changed, but no migration was added:
${report}

Projects made from the template before this change won't get it. Either:
  - add a migration to ${MIGRATIONS} that makes the same change in an existing project
    (see "Writing a migration" in packages/cli/README.md), or
  - put [no migration] in the pull request's description when existing projects don't need it
`)
  process.exit(1)
}

main()
