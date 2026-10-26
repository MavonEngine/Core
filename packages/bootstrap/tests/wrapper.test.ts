import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cliBinPath, isSupportedNode } from '../src/wrapper.ts'

describe('isSupportedNode', () => {
  it.each([
    ['v24.0.0', true],
    ['v25.1.2', true],
    ['v22.11.0', false],
    ['v18.20.4', false],
  ])('%s -> %s', (version, expected) => {
    expect(isSupportedNode(version)).toBe(expected)
  })
})

describe('cliBinPath', () => {
  it('points at the mavonengine bin of @mavonengine/cli', () => {
    const bin = cliBinPath()

    expect(bin.replaceAll('\\', '/')).toMatch(/cli\/dist\/index\.js$/)
    expect(existsSync(bin.replace(/dist[/\\]index\.js$/, 'package.json'))).toBe(true)
  })
})
