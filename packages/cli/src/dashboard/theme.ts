import type { Theme } from '@profullstack/hqtui'
import { contrast, defineTheme, mix, resolveTheme } from '@profullstack/hqtui'

/**
 * Contrast the dashboard wants for secondary text (labels, headers, axes).
 * Above WCAG AA (4.5) because with a transparent background the real
 * background is usually lighter than the theme's own.
 */
export const MIN_MUTED_CONTRAST = 6

/**
 * The named theme, with `muted` moved towards the foreground until it is readable.
 * Most built-in themes ship a muted color around 3-4:1, which is too dim for labels.
 */
export function readableTheme(name?: string): Theme {
  const base = resolveTheme(name)

  let muted = base.muted
  for (let t = 0.05; contrast(muted, base.background) < MIN_MUTED_CONTRAST && t <= 1; t += 0.05)
    muted = mix(base.muted, base.foreground, t)

  return defineTheme({ name: base.name, muted }, base)
}
