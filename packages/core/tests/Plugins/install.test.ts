import { describe, expect, it } from 'vitest'
import { invalidPackages, MAX_INSTALL_PACKAGES } from '../../src/Plugins/install'

describe('invalidPackages', () => {
  it('takes what a package manager installs', () => {
    for (const spec of ['forest', '@acme/forest', 'forest@1.2.0', '@acme/forest@latest', 'file:../my-plugin', './my-plugin', '../my-plugin', '~/plugins/forest', 'https://example.com/forest.tgz', 'github:acme/forest#main', 'git+https://github.com/acme/forest.git'])
      expect(invalidPackages([spec]), spec).toBeUndefined()

    expect(invalidPackages(['forest', '@acme/chat'])).toBeUndefined()
  })

  it('refuses options, shell syntax and version ranges', () => {
    for (const spec of ['-g', '--ignore-scripts=false', 'forest && calc', 'forest|calc', 'forest;calc', '`calc`', '$(calc)', 'forest > out', 'a b', 'forest@^1.0.0', '"forest"', 'forest\ncalc', '', 'x'.repeat(400)])
      expect(invalidPackages([spec]), spec).toContain('not something that can be installed')

    expect(invalidPackages(['forest', '-g'])).toBeDefined()
  })

  it('wants a list of a few packages', () => {
    expect(invalidPackages([])).toContain('at least one')
    expect(invalidPackages('forest')).toContain('at least one')
    expect(invalidPackages(undefined)).toContain('at least one')
    expect(invalidPackages([1])).toContain('not something')
    expect(invalidPackages(Array.from({ length: MAX_INSTALL_PACKAGES + 1 }).fill('forest'))).toContain('At most')
  })
})
