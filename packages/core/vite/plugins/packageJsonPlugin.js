import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PACKAGE_JSON_FILTER = /[/\\]package\.json$/
const ALL_FILTER = /.*/
const IDENTIFIER_FILTER = /^[a-z_$][\w$]*$/i

/*
 * Allows importing package.json as an ES module with named exports so the
 * client package can display the correct engine version at runtime.
 */
export function createPackageJsonPlugin(coreRoot) {
  return {
    name: 'package-json',
    setup(build) {
      build.onResolve({ filter: PACKAGE_JSON_FILTER }, (args) => {
        if (!args.path.includes('@mavonengine/core'))
          return null
        return { path: resolve(coreRoot, 'package.json'), namespace: 'mavonengine-pkg-json' }
      })
      build.onLoad({ filter: ALL_FILTER, namespace: 'mavonengine-pkg-json' }, (args) => {
        const pkg = JSON.parse(readFileSync(args.path, 'utf8'))
        const named = Object.entries(pkg)
          .filter(([k]) => IDENTIFIER_FILTER.test(k))
          .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
          .join('\n')
        return { contents: `${named}\nexport default ${JSON.stringify(pkg)};`, loader: 'js' }
      })
    },
  }
}
