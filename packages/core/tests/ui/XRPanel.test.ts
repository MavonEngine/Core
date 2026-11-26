// @vitest-environment jsdom
import { Group, PerspectiveCamera, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import XRPanel from '../../src/ui/XRPanel'
import { stubCanvas } from './canvasStub'

function head() {
  const rig = new Group()
  const camera = new PerspectiveCamera()
  rig.add(camera)
  camera.position.set(0, 1.6, 0)
  return camera
}

describe('xRPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    stubCanvas()
  })

  it('has a canvas of its size at its sharpness', () => {
    const panel = new XRPanel({ width: 1.2, height: 0.5, pixelsPerMeter: 800 })
    expect(panel.canvas.width).toBe(960)
    expect(panel.canvas.height).toBe(400)
    expect(panel.mesh.material.toneMapped).toBe(false)
    expect(panel.mesh.material.depthTest).toBe(false)
    expect(panel.mesh.userData.xrPanel).toBe(panel)
  })

  it('shows only while open and in VR', () => {
    const panel = new XRPanel()
    const camera = head()
    panel.update(camera, true, 0.016)
    expect(panel.mesh.visible).toBe(false)
    panel.open()
    panel.update(camera, false, 0.016)
    expect(panel.mesh.visible).toBe(false)
    panel.update(camera, true, 0.016)
    expect(panel.mesh.visible).toBe(true)
    panel.close()
    panel.update(camera, true, 0.016)
    expect(panel.mesh.visible).toBe(false)
  })

  it('opens in front of the head, level and facing it', () => {
    const panel = new XRPanel({ distance: 2, drop: 0.2 })
    const camera = head()
    camera.rotation.set(-0.5, Math.PI / 2, 0, 'YXZ') // looking left (-X) and down
    camera.updateMatrix()
    panel.open()
    panel.update(camera, true, 0.016)
    expect(panel.mesh.position.x).toBeCloseTo(-2)
    expect(panel.mesh.position.y).toBeCloseTo(1.4)
    expect(panel.mesh.position.z).toBeCloseTo(0)
    // its front (+Z) faces back at the head (+X)
    const front = new Vector3(0, 0, 1).applyQuaternion(panel.mesh.quaternion)
    expect(front.x).toBeCloseTo(1)
    expect(front.y).toBeCloseTo(0)
  })

  it('stays put for small head turns, and glides back in front after a large one', () => {
    const panel = new XRPanel({ distance: 2, followAngle: 35 })
    const camera = head()
    panel.open()
    panel.update(camera, true, 0.016)
    const start = panel.mesh.position.clone()

    camera.rotation.set(0, 0.3, 0) // 17 degrees
    panel.update(camera, true, 0.016)
    expect(panel.mesh.position.distanceTo(start)).toBe(0)

    camera.rotation.set(0, Math.PI / 2, 0)
    for (let i = 0; i < 200; i++) panel.update(camera, true, 0.016)
    expect(panel.mesh.position.x).toBeCloseTo(-2, 1)
    expect(panel.mesh.position.z).toBeCloseTo(0, 1)
  })

  it('opens in front again after being closed', () => {
    const panel = new XRPanel({ distance: 2, followAngle: 90 })
    const camera = head()
    panel.open()
    panel.update(camera, true, 0.016)
    panel.close()
    camera.rotation.set(0, Math.PI / 4, 0)
    panel.open()
    panel.update(camera, true, 0.016)
    expect(panel.mesh.position.x).toBeCloseTo(-2 * Math.sin(Math.PI / 4))
  })
})
