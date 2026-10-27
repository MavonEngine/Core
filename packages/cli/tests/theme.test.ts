import { contrast, themes } from '@profullstack/hqtui'
import { describe, expect, it } from 'vitest'
import { MIN_MUTED_CONTRAST, readableTheme } from '../src/dashboard/theme'

describe('readableTheme', () => {
  it.each(Object.keys(themes))('makes muted text readable in %s', (name) => {
    const theme = readableTheme(name)

    expect(contrast(theme.muted, theme.background)).toBeGreaterThanOrEqual(MIN_MUTED_CONTRAST)
  })

  it('keeps muted dimmer than the foreground', () => {
    const theme = readableTheme('dark')

    expect(contrast(theme.muted, theme.background)).toBeLessThan(contrast(theme.foreground, theme.background))
  })

  it('leaves already readable themes alone', () => {
    expect(readableTheme('highContrast').muted).toBe(themes.highContrast.muted)
  })

  it('keeps everything else from the base theme', () => {
    const theme = readableTheme('nord')

    expect(theme.name).toBe('nord')
    expect(theme.primary).toBe(themes.nord.primary)
    expect(theme.background).toBe(themes.nord.background)
  })

  it('falls back to the default theme', () => {
    expect(readableTheme().name).toBe(themes.dark.name)
  })
})
