import type XRPanel from './ui/XRPanel'
import type XRInput from './XRInput'
import type { XRActionEvent, XRController, XRHand } from './XRInput'
import { BufferGeometry, CircleGeometry, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'

/** How far the pointer line reaches when it isn't on a panel, in meters */
const RAY_LENGTH = 2

interface Hover {
  panel: XRPanel
  x: number
  y: number
}

/** One controller's line and the dot where it meets a panel */
interface Pointer {
  line: Line
  cursor: Mesh
  hover?: Hover
  /** The panel the trigger went down on, which gets its `pointerup` and `click` */
  pressed?: XRPanel
}

/**
 * The controllers pointing at XRPanels: a line out of each controller while a panel is open, a dot where it meets
 * one, and the panel's pointer events (see XRPanel) with the trigger as the button. Created by XR with the
 * controllers, as `xr.pointer`, and updated every rendered frame in VR.
 */
export default class XRPointer {
  private readonly raycaster = new Raycaster()
  private readonly pointers = new Map<XRHand, Pointer>()

  constructor(private readonly input: XRInput, private readonly panels: () => Iterable<XRPanel>) {
    for (const controller of input.controllers)
      this.pointers.set(controller.hand, createPointer())

    input.on('selectstart', ({ controller }: XRActionEvent) => this.press(controller))
    input.on('selectend', ({ controller }: XRActionEvent) => this.release(controller))
  }

  /**
   * The panel a controller points at, if any. A game can leave the trigger to the panel then, e.g. not brake or
   * shoot while the player clicks a menu
   */
  pointingAt(hand: XRHand): XRPanel | undefined {
    return this.pointers.get(hand)?.hover?.panel
  }

  /** Raycast every controller against the open panels and send them their events */
  update() {
    const open = [
      ...this.panels(),
    ].filter(panel => panel.mesh.visible)
    const meshes = open.map(panel => panel.mesh)

    for (const controller of this.input.controllers) {
      const pointer = this.pointers.get(controller.hand)!
      // On whichever slot the session gave this hand
      if (pointer.line.parent !== controller.ray) {
        controller.ray.add(pointer.line)
        controller.ray.add(pointer.cursor)
      }

      const active = controller.connected && open.length > 0
      pointer.line.visible = active
      pointer.cursor.visible = false
      if (!active) {
        this.leave(controller.hand, pointer)
        continue
      }

      const hit = controller.setRaycaster(this.raycaster).intersectObjects(meshes, false)[0]
      const panel = hit?.object.userData.xrPanel as XRPanel | undefined
      if (!hit || !panel || !hit.uv) {
        this.leave(controller.hand, pointer)
        pointer.line.scale.z = RAY_LENGTH
        continue
      }

      pointer.line.scale.z = hit.distance
      pointer.cursor.visible = true
      pointer.cursor.position.set(0, 0, -hit.distance + 0.002)

      const x = hit.uv.x * panel.canvas.width
      const y = (1 - hit.uv.y) * panel.canvas.height
      if (pointer.hover && pointer.hover.panel !== panel)
        this.leave(controller.hand, pointer)
      pointer.hover = { panel, x, y }
      panel.trigger('pointermove', { hand: controller.hand, x, y })
    }
  }

  private press(controller: XRController) {
    const pointer = this.pointers.get(controller.hand)
    const hover = pointer?.hover
    if (!pointer || !hover)
      return
    pointer.pressed = hover.panel
    hover.panel.trigger('pointerdown', { hand: controller.hand, x: hover.x, y: hover.y })
  }

  private release(controller: XRController) {
    const pointer = this.pointers.get(controller.hand)
    const pressed = pointer?.pressed
    if (!pointer || !pressed)
      return
    pointer.pressed = undefined
    const hover = pointer.hover
    const event = { hand: controller.hand, x: hover?.x ?? -1, y: hover?.y ?? -1 }
    pressed.trigger('pointerup', event)
    // A click is let go on the panel it went down on
    if (hover?.panel === pressed)
      pressed.trigger('click', event)
  }

  private leave(hand: XRHand, pointer: Pointer) {
    if (!pointer.hover)
      return
    pointer.hover.panel.trigger('pointerleave', { hand, x: pointer.hover.x, y: pointer.hover.y })
    pointer.hover = undefined
  }

  dispose() {
    for (const pointer of this.pointers.values()) {
      pointer.line.removeFromParent()
      pointer.cursor.removeFromParent()
      pointer.line.geometry.dispose()
      pointer.cursor.geometry.dispose()
    }
  }
}

function createPointer(): Pointer {
  const line = new Line(
    new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(0, 0, -1),
    ]),
    new LineBasicMaterial({
      color: 0xFFFFFF,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      toneMapped: false,
      fog: false,
    }),
  )
  line.name = 'XRPointerLine'
  line.renderOrder = 1002
  line.scale.z = RAY_LENGTH
  line.visible = false

  const cursor = new Mesh(
    new CircleGeometry(0.008, 16),
    new MeshBasicMaterial({
      color: 0xFFFFFF,
      depthTest: false,
      toneMapped: false,
      fog: false,
    }),
  )
  cursor.name = 'XRPointerCursor'
  cursor.renderOrder = 1003
  cursor.visible = false
  return { line, cursor }
}
