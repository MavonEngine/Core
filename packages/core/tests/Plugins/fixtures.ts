import type { Buffer } from 'node:buffer'
import type { MavonEngineConfig, PluginManifest } from '../../src/Plugins/ProjectConfig'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A new project directory under the temp dir, as its long path: on Windows the temp dir can contain 8.3 short names
 * (C:/Users/RUNNER~1/...), and Vite denies every path with a short-name segment
 */
export function tempProject(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'mavonengine-plugins-')))
}

export function writeConfig(root: string, config: Partial<MavonEngineConfig> | string) {
  writeFileSync(join(root, 'mavonengine.json'), typeof config === 'string' ? config : JSON.stringify(config))
}

export function writeFile(path: string, content: string | Buffer = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * Install a fake plugin into `<root>/node_modules/<pkg>`. `files` are written relative to the package.
 */
export function installPlugin(root: string, pkg: string, manifest: PluginManifest | undefined, files: Record<string, string> = {}): string {
  const dir = join(root, 'node_modules', pkg)
  writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', type: 'module', ...(manifest ? { mavonengine: manifest } : {}) }))
  for (const [path, content] of Object.entries(files))
    writeFile(join(dir, path), content)
  return dir
}
