// @vitest-environment jsdom
import { Group, PerspectiveCamera } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TextLabel from '../../src/ui/TextLabel'
import { stubCanvas } from './canvasStub'

describe('textLabel', () => {
  let canvas: ReturnType<typeof stubCanvas>
  beforeEach(() => {
    vi.restoreAllMocks()
    canvas = stubCanvas()
  })

  it('draws its lines on a canvas sized to them, shaped like it in the world', () => {
    const label = new TextLabel('Alice\nhello there', { font: '40px sans-serif', padding: 10, height: 0.5 })
    expect(canvas.drawn).toEqual(['Alice', 'hello there'])
    // the longest line is 11 characters at 20 px, two lines of 50 px
    expect(label.canvas.width).toBe(220 + 20)
    expect(label.canvas.height).toBe(100 + 20)
    expect(label.scale.y).toBeCloseTo(0.5)
    expect(label.scale.x).toBeCloseTo(0.5 * 240 / 120)
  })

  it('is unlit, out of tone mapping and fog, and drawn over the scene unless asked', () => {
    const label = new TextLabel('x')
    expect(label.material.toneMapped).toBe(false)
    expect(label.material.fog).toBe(false)
    expect(label.material.depthTest).toBe(false)
    expect(label.castShadow).toBe(false)
    expect(new TextLabel('x', { depthTest: true }).material.depthTest).toBe(true)
  })

  it('redraws only when the text changes, and hides with none', () => {
    const label = new TextLabel('a')
    label.setText('a')
    expect(canvas.drawn).toEqual(['a'])
    label.setText('')
    expect(label.visible).toBe(false)
    label.setText('b')
    expect(label.visible).toBe(true)
  })

  it('draws an icon as tall as the font left of the text, and widens for it', () => {
    const label = new TextLabel('Bob', { font: '40px sans-serif', padding: 10 })
    const without = label.canvas.width
    const icon = Object.assign(document.createElement('canvas'), { width: 80, height: 40 })
    label.setIcon(icon)
    // 80 px wide at 40 tall, and half the padding between it and the text
    expect(label.canvas.width).toBe(without + 80 + 5)
    expect(canvas.ctx.drawImage).toHaveBeenCalledWith(icon, 10, (label.canvas.height - 40) / 2, 80, 40)
    expect(canvas.ctx.fillText).toHaveBeenLastCalledWith('Bob', 10 + 85 + 30, expect.any(Number))

    label.setIcon(undefined)
    expect(label.canvas.width).toBe(without)
  })

  it('keeps its angular size whatever the distance', () => {
    const camera = new PerspectiveCamera()
    const label = new TextLabel('x', { angularSize: 2 })
    label.position.set(0, 0, -100)
    label.updateMatrixWorld()
    label.update(camera)
    const near = label.scale.y
    expect(near).toBeCloseTo(2 * 100 * Math.tan(Math.PI / 180))

    label.position.set(0, 0, -400)
    label.updateMatrixWorld()
    label.update(camera)
    expect(label.scale.y).toBeCloseTo(near * 4)
  })

  it('sizes in its parent\'s scale', () => {
    const parent = new Group()
    parent.scale.setScalar(2)
    const label = new TextLabel('x', { angularSize: 2 })
    parent.add(label)
    label.position.set(0, 0, -50) // 100 m out in the world
    parent.updateMatrixWorld()
    label.update(new PerspectiveCamera())
    expect(label.scale.y * 2).toBeCloseTo(2 * 100 * Math.tan(Math.PI / 180))
  })
})
