import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareVersions, engineCompat, engineRangeOf, maxSatisfying, parseVersion, satisfies, validRange } from '../../src/Plugins/compat'
import { enabledPlugins } from '../../src/Plugins/ProjectConfig'
import { installPlugin, tempProject, writeConfig, writeFile } from './fixtures'

describe('versions', () => {
  it('reads full versions only', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    })
    expect(parseVersion('v0.0.25-beta.2+build.7')).toEqual({
      major: 0,
      minor: 0,
      patch: 25,
      prerelease: ['beta', 2],
    })
    expect(parseVersion('1.2')).toBeUndefined()
    expect(parseVersion('latest')).toBeUndefined()
  })

  it('orders them like npm', () => {
    const sorted = [
      '1.0.0',
      '1.0.0-rc.1',
      '0.9.10',
      '1.0.0-beta.11',
      '1.0.0-beta.2',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '0.9.9',
    ]
      .map(v => parseVersion(v)!)
      .sort(compareVersions)
      .map(v => `${v.major}.${v.minor}.${v.patch}${v.prerelease.length
        ? `-${v.prerelease.join('.')}`
        : ''}`)

    expect(sorted).toEqual([
      '0.9.9',
      '0.9.10',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ])
  })
})

describe('ranges', () => {
  const cases: [string, string[], string[]][] = [
    [
      '>=0.0.22',
      ['0.0.22', '0.0.25', '1.0.0'],
      ['0.0.21'],
    ],
    [
      '^0.0.25',
      ['0.0.25'],
      ['0.0.24', '0.0.26'],
    ],
    [
      '^0.2.1',
      ['0.2.1', '0.2.9'],
      ['0.3.0', '0.2.0'],
    ],
    [
      '^1.2.3',
      ['1.2.3', '1.9.0'],
      ['2.0.0', '1.2.2', '2.0.0-0'],
    ],
    [
      '^0.0',
      ['0.0.0', '0.0.9'],
      ['0.1.0'],
    ],
    [
      '~1.2.3',
      ['1.2.3', '1.2.9'],
      ['1.3.0'],
    ],
    [
      '~1',
      ['1.0.0', '1.9.9'],
      ['2.0.0'],
    ],
    [
      '1.x',
      ['1.0.0', '1.5.2'],
      ['2.0.0', '0.9.0'],
    ],
    [
      '1.2',
      ['1.2.0', '1.2.7'],
      ['1.3.0'],
    ],
    [
      '*',
      ['0.0.1', '9.9.9'],
      ['1.0.0-beta'],
    ],
    [
      '',
      ['1.0.0'],
      [],
    ],
    [
      '>1.2',
      ['1.3.0'],
      ['1.2.9'],
    ],
    [
      '<=1.2',
      ['1.2.9'],
      ['1.3.0'],
    ],
    [
      '<1.2',
      ['1.1.9'],
      ['1.2.0'],
    ],
    [
      '>= 0.0.22 < 0.1',
      ['0.0.30'],
      ['0.1.0', '0.0.21'],
    ],
    [
      '1.0.0 - 1.4',
      ['1.0.0', '1.4.9'],
      ['1.5.0', '0.9.9'],
    ],
    [
      '^0.0.25 || >=1',
      ['0.0.25', '1.2.0'],
      ['0.0.26'],
    ],
    [
      '=1.2.3',
      ['1.2.3', 'v1.2.3'],
      ['1.2.4'],
    ],
    [
      '>=1.0.0-beta',
      ['1.0.0-beta.2', '1.0.0', '1.2.0'],
      ['1.1.0-beta', '1.0.0-alpha'],
    ],
  ]

  for (const [range, inside, outside] of cases) {
    it(`'${range}'`, () => {
      for (const version of inside)
        expect(satisfies(version, range), `${version} in ${range}`).toBe(true)
      for (const version of outside)
        expect(satisfies(version, range), `${version} not in ${range}`).toBe(false)
    })
  }

  it('says no to what it can\'t read', () => {
    expect(validRange('>=0.0.22')).toBe(true)
    expect(validRange('workspace:*')).toBe(false)
    expect(validRange('latest')).toBe(false)
    expect(validRange('>=banana')).toBe(false)
    expect(satisfies('1.0.0', 'file:../core')).toBe(false)
    expect(satisfies('not-a-version', '*')).toBe(false)
  })

  it('finds the newest version in a range', () => {
    expect(maxSatisfying([
      '0.1.0',
      '0.2.0',
      '0.2.5',
      '1.0.0',
      '0.3.0-beta',
    ], '<1')).toBe('0.2.5')
    expect(maxSatisfying(['1.0.0'], '>=2')).toBeUndefined()
  })
})

describe('engine compatibility', () => {
  it('reads the range from the manifest, else the peer dependency', () => {
    expect(engineRangeOf({
      mavonengine: { engine: '>=0.0.25' },
      peerDependencies: { '@mavonengine/core': '*' },
    })).toBe('>=0.0.25')
    expect(engineRangeOf({
      mavonengine: {},
      peerDependencies: { '@mavonengine/core': '^0.0.24' },
    })).toBe('^0.0.24')
    expect(engineRangeOf({ name: 'x' })).toBeUndefined()
  })

  it('is unknown when there is nothing to compare', () => {
    expect(engineCompat('>=0.0.25', '0.0.25')).toBe('compatible')
    expect(engineCompat('>=0.0.26', '0.0.25')).toBe('incompatible')
    expect(engineCompat(undefined, '0.0.25')).toBe('unknown')
    expect(engineCompat('>=0.0.25', undefined)).toBe('unknown')
    expect(engineCompat('nonsense', '0.0.25')).toBe('unknown')
  })

  describe('when plugins load', () => {
    let root: string

    beforeEach(() => {
      root = tempProject()
      writeFile(join(root, 'node_modules', '@mavonengine', 'core', 'package.json'), JSON.stringify({ name: '@mavonengine/core', version: '0.0.25' }))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('warns about a plugin made for another core, and loads it anyway', () => {
      installPlugin(root, 'old', { target: 'server', server: 'server.js', engine: '>=0.0.22' }, { 'server.js': '' })
      installPlugin(root, 'new', { target: 'server', server: 'server.js', engine: '>=0.0.26' }, { 'server.js': '' })
      writeConfig(root, {
        plugins: { old: {}, new: {} },
      })

      const { plugins, warnings, incompatible } = enabledPlugins(root, 'server')

      expect(plugins.map(plugin => plugin.package)).toEqual(['old', 'new'])
      expect(warnings).toEqual([])
      expect(incompatible).toEqual(['new 1.0.0 is made for @mavonengine/core >=0.0.26, the project has 0.0.25, run \'mavonengine doctor\''])
    })
  })
})
