import { describe, expect, it } from 'vitest'
import { bootBanner } from '../../src/Utils/BootBanner'

describe('bootBanner', () => {
  it('lists the versions in a closed box', () => {
    const lines = bootBanner({ version: '0.0.20', threeRevision: '180', rapierVersion: '0.19.0', mode: 'production' })

    expect(lines).toContain('│  Version:  0.0.20                       │')
    expect(lines).toContain('│  Three.js: r180                         │')
    expect(lines).toContain('│  Rapier:   0.19.0                       │')
    expect(lines).toContain('│  Mode:     production                   │')
    expect(new Set(lines.map(line => line.length))).toEqual(new Set([lines[0].length]))
  })

  it('leaves out the versions it was not given', () => {
    const lines = bootBanner({ version: '0.0.20', mode: 'development' })

    expect(lines.some(line => line.includes('Three.js') || line.includes('Rapier'))).toBe(false)
  })
})
