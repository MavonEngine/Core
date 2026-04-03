import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPackageJsonPlugin } from '../../../vite/plugins/packageJsonPlugin.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

describe('createPackageJsonPlugin', () => {
  let resolveHandler: (args: { path: string }) => { path: string, namespace: string }
  let loadHandler: (args: { path: string }) => { contents: string, loader: string }

  beforeEach(() => {
    const plugin = createPackageJsonPlugin('/fake/core/root')
    const mockBuild = {
      onResolve: vi.fn((_: unknown, handler: typeof resolveHandler) => {
        resolveHandler = handler
      }),
      onLoad: vi.fn((_: unknown, handler: typeof loadHandler) => {
        loadHandler = handler
      }),
    }
    plugin.setup(mockBuild)
  })

  describe('onResolve', () => {
    it('resolves @mavonengine/core package.json to coreRoot', () => {
      const result = resolveHandler({ path: '@mavonengine/core/package.json' })
      expect(result.path).toBe('/fake/core/root/package.json')
      expect(result.namespace).toBe('mavonengine-pkg-json')
    })

    it('returns null for non-core package.json paths', () => {
      const result = resolveHandler({ path: '/some/other/package.json' })
      expect(result).toBeNull()
    })
  })

  describe('onLoad', () => {
    it('generates named exports for valid identifier keys', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ name: 'test-pkg', version: '1.0.0' }))
      const result = loadHandler({ path: '/fake/package.json' })
      expect(result.contents).toContain('export const name = "test-pkg";')
      expect(result.contents).toContain('export const version = "1.0.0";')
    })

    it('filters out non-identifier keys from named exports', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ 'hyphen-key': 'value', '@scoped': 'foo', 'valid': 'yes' }),
      )
      const result = loadHandler({ path: '/fake/package.json' })
      expect(result.contents).not.toContain('export const hyphen-key')
      expect(result.contents).not.toContain('export const @scoped')
      expect(result.contents).toContain('export const valid = "yes";')
    })

    it('includes a default export of the full package object', () => {
      const pkg = { 'name': 'test', 'version': '1.0.0', 'non-identifier': true }
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(pkg))
      const result = loadHandler({ path: '/fake/package.json' })
      expect(result.contents).toContain(`export default ${JSON.stringify(pkg)};`)
    })

    it('sets loader to js', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}))
      const result = loadHandler({ path: '/fake/package.json' })
      expect(result.loader).toBe('js')
    })
  })
})
