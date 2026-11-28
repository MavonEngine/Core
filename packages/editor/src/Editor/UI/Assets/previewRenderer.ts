import { WebGLRenderer } from 'three'

/** Rendered at twice the 64px tile so previews stay sharp on high density screens */
export const PREVIEW_SIZE = 128

/**
 * Runs `draw` with a temporary offscreen renderer, then releases its WebGL context, so the Assets panel
 * never holds one open next to the game's. Returns false when WebGL isn't available.
 */
export function withPreviewRenderer(draw: (renderer: WebGLRenderer) => void, options: { shadows?: boolean } = {}): boolean {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
  }
  catch {
    return false
  }
  renderer.setPixelRatio(1)
  renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE, false)
  renderer.setClearColor(0x000000, 0)
  if (options.shadows)
    renderer.shadowMap.enabled = true

  try {
    draw(renderer)
  }
  finally {
    renderer.dispose()
    renderer.forceContextLoss()
  }
  return true
}
