import type { GamepadState } from '@mavonengine/core/GamepadManager'
import { useEffect, useState } from 'react'

/**
 * Connected controllers from the running game.
 * Re-renders on connect / disconnect, and every animation frame when `live` is set.
 */
export function useGamepads(live = false): GamepadState[] {
  const manager = window.Game?.input?.gamepads
  const [, setFrame] = useState(0)

  useEffect(() => {
    if (!manager)
      return

    const refresh = () => setFrame(f => f + 1)
    manager.on('connected', refresh)
    manager.on('disconnected', refresh)

    let raf = 0
    if (live) {
      const loop = () => {
        refresh()
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }

    return () => {
      manager.off('connected', refresh)
      manager.off('disconnected', refresh)
      cancelAnimationFrame(raf)
    }
  }, [manager, live])

  return manager ? [...manager.gamepads.values()] : []
}
