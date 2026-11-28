import type XRInput from './XRInput'
import { Group, Mesh, Object3D, Vector2 } from 'three'
import Game from './Game'
import GamepadManager from './GamepadManager'
import EventEmitter from './Utils/EventEmitter'

export default class InputManager extends EventEmitter {
  keysPressed: Map<string, true> = new Map()
  mousePressed: Map<number, true> = new Map()

  cursor = new Vector2()

  /** Connected game controllers (Xbox, PlayStation, generic) */
  readonly gamepads = new GamepadManager()

  /** VR controllers, once `game.enableXR()` was called */
  xr?: XRInput

  constructor() {
    super()

    window.addEventListener('keydown', (ev) => {
      this.keysPressed.set(ev.code, true)
      this.trigger('keydown', ev)
    })

    window.addEventListener('keyup', (ev) => {
      this.keysPressed.delete(ev.code)

      this.trigger('keyup', ev)
    })

    window.addEventListener('mousedown', (ev) => {
      this.mousePressed.set(ev.button, true)
      this.trigger('mousedown', ev)
    })

    window.addEventListener('mouseup', (ev) => {
      this.mousePressed.delete(ev.button)
    })

    // Keys or buttons held while the window loses focus (clicking out of an
    // iframe, alt-tab, switching tabs) never get their keyup/mouseup, so they
    // would stay "pressed" forever. Drop everything when focus goes away.
    const releaseAll = () => {
      this.keysPressed.clear()
      this.mousePressed.clear()
    }
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden)
        releaseAll()
    })

    window.addEventListener('mousemove', ev => this.updateCursor(ev))
    // Also on press, so a click without a move before it (e.g. a touch tap) picks where it happened
    window.addEventListener('pointerdown', ev => this.updateCursor(ev))
  }

  /**
   * The cursor in normalized device coordinates (-1 to 1) of the canvas, not the window:
   * in the editor the canvas is a panel that doesn't start at the window's corner.
   */
  updateCursor(ev: { clientX: number, clientY: number }) {
    const rect = Game.instance().canvas?.getBoundingClientRect()
    const hasRect = !!rect && rect.width > 0 && rect.height > 0
    const left = hasRect ? rect.left : 0
    const top = hasRect ? rect.top : 0
    const width = hasRect
      ? rect.width
      : Game.instance().sizes.width
    const height = hasRect
      ? rect.height
      : Game.instance().sizes.height
    this.cursor.set(
      (ev.clientX - left) / width * 2 - 1,
      -((ev.clientY - top) / height * 2 - 1),
    )
  }

  /**
   * Poll devices that do not push events, like gamepads.
   * Called by Game once per update before the world updates.
   */
  update() {
    this.gamepads.poll()
    this.xr?.poll()
  }

  /**
   * Check where the player is currently pointing in the world
   */
  getPointerWorldPosition(except?: Object3D, only?: string | null, returnObject = false) {
    Game.instance().rayCaster.setFromCamera(Game.instance().input.cursor, Game.instance().camera.instance)
    const collision = Game.instance().rayCaster.intersectObjects(
      Game.instance().scene.children.filter((child) => {
        if ((child instanceof Mesh || child instanceof Group) && !(except instanceof Object3D && child === except)) {
          if (only && child.userData.type !== only) {
            return null
          }

          return child
        }

        return null
      }),
    )

    if (collision[0]) {
      if (returnObject) {
        return collision[0].object
      }

      return collision[0].point
    }
  }
}
