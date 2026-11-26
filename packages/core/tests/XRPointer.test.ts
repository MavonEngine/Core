// @vitest-environment jsdom
import { Group } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import XRPanel from '../src/ui/XRPanel'
import EventEmitter from '../src/Utils/EventEmitter'
import { XRController } from '../src/XRInput'
import XRPointer from '../src/XRPointer'
import { stubCanvas } from './ui/canvasStub'

/** controllers at the origin pointing down -Z, and a 1 x 1 m panel 1 m in front, 1000 px a side */
function setup() {
  const input = Object.assign(new EventEmitter(), {
    left: new XRController('left', new Group() as any, new Group() as any),
    right: new XRController('right', new Group() as any, new Group() as any),
    get controllers() {
      return [this.left, this.right]
    },
  })
  input.right.inputSource = { handedness: 'right' } as XRInputSource
  const panel = new XRPanel({ width: 1, height: 1, follow: 'none' })
  panel.mesh.position.set(0, 0, -1)
  panel.mesh.visible = true
  panel.mesh.updateMatrixWorld()
  const pointer = new XRPointer(input as any, () => [panel])
  const events: [string, any][] = []
  for (const type of [
    'pointermove',
    'pointerleave',
    'pointerdown',
    'pointerup',
    'click',
  ])
    panel.on(type, (e: any) => events.push([type, e]))
  return { input, panel, pointer, events }
}

describe('xRPointer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    stubCanvas()
  })

  it('tells the panel where on its canvas a controller points', () => {
    const { input, pointer, panel, events } = setup()
    input.right.ray.rotation.set(0, -Math.atan(0.25), 0) // 0.25 m right of the centre
    input.right.ray.updateMatrixWorld()
    pointer.update()
    expect(events).toHaveLength(1)
    const [type, e] = events[0]
    expect(type).toBe('pointermove')
    expect(e.hand).toBe('right')
    expect(e.x).toBeCloseTo(750)
    expect(e.y).toBeCloseTo(500)
    expect(pointer.pointingAt('right')).toBe(panel)
    // the disconnected left one points at nothing
    expect(pointer.pointingAt('left')).toBeUndefined()
  })

  it('shows a line to the panel and a dot on it, only while one is open', () => {
    const { input, pointer, panel } = setup()
    pointer.update()
    const line = input.right.ray.getObjectByName('XRPointerLine')!
    const cursor = input.right.ray.getObjectByName('XRPointerCursor')!
    expect(line.visible).toBe(true)
    expect(line.scale.z).toBeCloseTo(1)
    expect(cursor.visible).toBe(true)

    panel.mesh.visible = false
    pointer.update()
    expect(line.visible).toBe(false)
    expect(cursor.visible).toBe(false)
  })

  it('clicks with the trigger let go on the same panel', () => {
    const { input, pointer, events } = setup()
    pointer.update()
    input.trigger('selectstart', { controller: input.right })
    input.trigger('selectend', { controller: input.right })
    expect(events.map(([type]) => type)).toEqual([
      'pointermove',
      'pointerdown',
      'pointerup',
      'click',
    ])
  })

  it('doesn\'t click when the trigger is let go off the panel', () => {
    const { input, pointer, events } = setup()
    pointer.update()
    input.trigger('selectstart', { controller: input.right })
    input.right.ray.rotation.set(0, Math.PI / 2, 0) // away
    input.right.ray.updateMatrixWorld()
    pointer.update()
    input.trigger('selectend', { controller: input.right })
    expect(events.map(([type]) => type)).toEqual([
      'pointermove',
      'pointerdown',
      'pointerleave',
      'pointerup',
    ])
  })

  it('ignores the trigger when pointing at nothing', () => {
    const { input, events } = setup()
    input.trigger('selectstart', { controller: input.right })
    input.trigger('selectend', { controller: input.right })
    expect(events).toHaveLength(0)
  })
})
