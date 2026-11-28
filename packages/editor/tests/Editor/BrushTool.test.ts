// @vitest-environment jsdom
import type { BrushDefinition } from '@mavonengine/core/Brushes/BrushRegistry'
import { registerBrush, unregisterBrush } from '@mavonengine/core/Brushes/BrushRegistry'
import Game from '@mavonengine/core/Game'
import { Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrushTool from '../../src/Editor/Brushes/BrushTool'

vi.mock('@mavonengine/core/Game', () => ({
  default: {
    instance: vi.fn(),
  },
}))

let canvas: HTMLCanvasElement
let scene: Scene
let tool: BrushTool
const editor = {
  deselect: vi.fn(),
  activeItem: null,
  cameraControls: { enabled: true },
  trigger: vi.fn(),
}

/** A brush that counts its stamps, and undoes by counting back */
function countingBrush() {
  const state = { stamps: 0, inverted: 0, ended: 0 }
  const definition: BrushDefinition = {
    name: 'count',
    plugin: '@acme/test',
    group: 'Test',
    target: 'surface',
    begin: () => ({
      stamp(_hit, context) {
        state.stamps++
        if (context.invert)
          state.inverted++
      },
      end() {
        state.ended++
        const stamps = state.stamps
        return {
          undo: () => (state.stamps = 0),
          redo: () => (state.stamps = stamps),
        }
      },
    }),
  }
  return {
    definition,
    state,
    key: registerBrush(definition),
  }
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}) {
  const event = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    ...init,
  }) as PointerEvent
  ;(type === 'pointerdown'
    ? canvas
    : window).dispatchEvent(event)
  if (type === 'pointermove')
    canvas.dispatchEvent(event)
}

beforeEach(() => {
  localStorage.clear()
  canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
  }) as DOMRect
  document.body.appendChild(canvas)
  scene = new Scene()
  // A ground plane below a camera looking straight down
  const ground = new Mesh(new PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new MeshBasicMaterial())
  scene.add(ground)
  scene.updateMatrixWorld(true)
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000)
  camera.position.set(0, 20, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  vi.mocked(Game.instance).mockReturnValue({
    canvas,
    scene,
    camera: { instance: camera },
    activeScene: {
      getEntries: () => [],
      trigger: vi.fn(),
    },
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    },
  } as any)
  tool = new BrushTool(editor as any)
})

afterEach(() => {
  tool.dispose()
  canvas.remove()
})

describe('brush tool', () => {
  it('does nothing until a brush is picked', () => {
    const { state, key } = countingBrush()
    pointer('pointerdown', 50, 50)
    pointer('pointerup', 50, 50)
    expect(state.stamps).toBe(0)
    expect(tool.active).toBe(false)
    unregisterBrush(key)
  })

  it('paints a stroke with a plugin\'s brush, spaced along the drag, and undoes it', () => {
    const { state, key } = countingBrush()
    tool.setBrush(key)
    expect(tool.active).toBe(true)
    expect(editor.deselect).toHaveBeenCalled()

    pointer('pointerdown', 50, 50)
    expect(state.stamps).toBe(1)
    expect(editor.cameraControls.enabled).toBe(false)
    pointer('pointermove', 80, 50)
    expect(state.stamps).toBeGreaterThan(2)
    pointer('pointerup', 80, 50)
    expect(state.ended).toBe(1)
    expect(editor.cameraControls.enabled).toBe(true)

    expect(tool.canUndo).toBe(true)
    const stamps = state.stamps
    tool.undo()
    expect(state.stamps).toBe(0)
    tool.redo()
    expect(state.stamps).toBe(stamps)
    unregisterBrush(key)
  })

  it('passes Shift on as invert and puts the brush down with Escape', () => {
    const { state, key } = countingBrush()
    tool.setBrush(key)
    pointer('pointerdown', 50, 50, { shiftKey: true })
    pointer('pointerup', 50, 50)
    expect(state.inverted).toBe(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight' }))
    expect(tool.settings.radius).toBeGreaterThan(5)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }))
    expect(tool.active).toBe(false)
    unregisterBrush(key)
  })

  it('keeps each brush\'s options, with defaults', () => {
    const key = registerBrush({
      name: 'opt',
      group: 'Test',
      target: 'surface',
      options: [
        {
          type: 'slider',
          key: 'width',
          label: 'width',
          min: 0,
          max: 10,
          step: 1,
          default: 4,
        },
      ],
      begin: () => undefined,
    })
    expect(tool.options(key)).toEqual({ width: 4 })
    tool.setOption(key, 'width', 7)
    expect(tool.options(key)).toEqual({ width: 7 })
    unregisterBrush(key)
  })
})
